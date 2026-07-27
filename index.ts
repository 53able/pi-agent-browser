import type { ExtensionAPI, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PREVIEW_CHARS = 12_000;
const DEFAULT_ARTIFACT_DIR = "outputs/browser";

// Heuristics for content that signals a human-only checkpoint (2FA, CAPTCHA, identity
// verification). These are advisory only — read/snapshot stay non-destructive, so we
// annotate the result instead of blocking. Actual pausing happens in agent_browser_handoff.
const SENSITIVE_CONTENT_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: "2FA / one-time code",
    pattern: /\b(two[-\s]?factor|2fa|one[-\s]?time (?:code|password)|otp|verification code)\b|認証コード|二段階認証|二要素認証|ワンタイムパスワード/i,
  },
  {
    label: "CAPTCHA",
    pattern: /\b(captcha|recaptcha|hcaptcha|prove you.?re (?:not a robot|human)|are you a robot)\b|画像認証|パズル認証/i,
  },
  {
    label: "identity verification",
    pattern: /\bverify your identity\b|\bidentity verification\b|\bconfirm it.?s you\b|本人確認|身分証明/i,
  },
];

function scanForSensitiveContent(text: string): string[] {
  const hits: string[] = [];
  for (const { label, pattern } of SENSITIVE_CONTENT_PATTERNS) {
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}

// Tracks whether each agent-browser session was last opened headed, so
// agent_browser_handoff / agent_browser_commit can tell a human definitively
// whether a visible browser window exists for them to act in, instead of guessing.
const SESSION_STATE_DIR = ".pi-agent-browser";
const SESSION_STATE_FILE = "sessions.json";
const DEFAULT_SESSION_KEY = "__default__";

type SessionState = { headed: boolean; lastUrl?: string; loginBrowserPid?: number; loginDebugPort?: number; updatedAt: string };

type SessionStatePatch = Partial<Omit<SessionState, "updatedAt">> & { clearLoginBrowserPid?: boolean };

function sessionKey(params: JsonObject): string {
  return typeof params.session === "string" && params.session.trim() ? params.session.trim() : DEFAULT_SESSION_KEY;
}

async function readSessionStates(cwd: string): Promise<Record<string, SessionState>> {
  try {
    const raw = await readFile(join(cwd, SESSION_STATE_DIR, SESSION_STATE_FILE), "utf8");
    return JSON.parse(raw) as Record<string, SessionState>;
  } catch {
    return {};
  }
}

async function writeSessionState(cwd: string, session: string, patch: SessionStatePatch): Promise<void> {
  const dir = join(cwd, SESSION_STATE_DIR);
  await mkdir(dir, { recursive: true });
  const states = await readSessionStates(cwd);
  const previous = states[session];
  states[session] = {
    headed: patch.headed ?? previous?.headed ?? false,
    lastUrl: patch.lastUrl ?? previous?.lastUrl,
    loginBrowserPid: patch.clearLoginBrowserPid ? undefined : (patch.loginBrowserPid ?? previous?.loginBrowserPid),
    loginDebugPort: patch.clearLoginBrowserPid ? undefined : (patch.loginDebugPort ?? previous?.loginDebugPort),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, SESSION_STATE_FILE), JSON.stringify(states, null, 2), "utf8");
}

function reopenHeadedGuidance(session: string, lastUrl: string | undefined): string[] {
  const sessionArg = session === DEFAULT_SESSION_KEY ? {} : { session };
  const reopenArgs = JSON.stringify({ ...sessionArg, headed: true, restore: true, ...(lastUrl ? { url: lastUrl } : {}) });
  return [
    `⚠ このセッション(${session === DEFAULT_SESSION_KEY ? "既定セッション" : session})はheadless(ウィンドウ非表示)で開かれています。`,
    `人間が直接操作できるようにするには、agent_browser_open を次の引数で呼び直してください: ${reopenArgs}`,
    "同じセッション名なのでcookie等は復元されますが、2FA/CAPTCHAなど使い切り・期限付きのチャレンジは、再度最初からやり直しになる場合があります。",
  ];
}

type JsonObject = Record<string, unknown>;

type RunResult = {
  ok: boolean;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
};

type ToolDetails = RunResult & {
  artifactPaths?: string[];
  parsedJson?: unknown;
  securityFlags?: string[];
};

function optionalString(description: string) {
  return Type.Optional(Type.String({ description }));
}

function optionalBoolean(description: string) {
  return Type.Optional(Type.Boolean({ description }));
}

function optionalStringArray(description: string) {
  return Type.Optional(Type.Array(Type.String(), { description }));
}

function commonSchema(extra: JsonObject = {}) {
  return {
    session: optionalString("agent-browser session name. Use this to isolate or reuse browser state."),
    allowedDomains: optionalStringArray("Optional domain allowlist forwarded to --allowed-domains. Example: ['example.com', '*.example.com']."),
    maxOutput: Type.Optional(Type.Integer({ minimum: 1, description: "Forwarded to --max-output for output containment." })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Tool execution timeout in milliseconds." })),
    extraArgs: optionalStringArray("Advanced raw agent-browser CLI args appended after generated args. Use sparingly."),
    ...extra,
  };
}

const OpenSchema = Type.Object(commonSchema({
  url: optionalString("URL to open. Omit to launch about:blank."),
  headed: optionalBoolean("Launch headed browser window when true."),
  profile: optionalString("Chrome profile path or profile name forwarded to --profile."),
  restore: Type.Optional(Type.Union([Type.Boolean(), Type.String()], { description: "Enable --restore auto-save/restore, or pass a restore key/path when supported." })),
}));

const ReadSchema = Type.Object(commonSchema({
  url: optionalString("URL to fetch/read. Omit to read the active rendered tab DOM."),
  json: optionalBoolean("Return agent-browser JSON output where supported."),
  raw: optionalBoolean("Return raw response body for URL reads."),
  outline: optionalBoolean("Return compact heading outline."),
  requireMd: optionalBoolean("Fail unless the server returns markdown."),
  filter: optionalString("Filter text for read extraction, outline, or llms sections."),
  llms: Type.Optional(Type.Union([Type.Literal("index"), Type.Literal("full")], { description: "Read nearest llms.txt index or llms-full.txt." })),
  outputPath: optionalString("Optional path to save full stdout. Relative paths resolve from cwd."),
}));

const SnapshotSchema = Type.Object(commonSchema({
  outputPath: optionalString("Optional path to save the snapshot stdout. Relative paths resolve from cwd."),
}));

const ClickSchema = Type.Object(commonSchema({
  selector: Type.String({ description: "Element ref from snapshot, such as @e2, or a CSS selector." }),
  newTab: optionalBoolean("Open target in a new tab when supported."),
}));

const FillSchema = Type.Object(commonSchema({
  selector: Type.String({ description: "Input ref from snapshot, such as @e3, or a CSS selector." }),
  text: Type.String({ description: "Text to fill into the element." }),
}));

const ScreenshotSchema = Type.Object(commonSchema({
  path: optionalString("Output screenshot path. Relative paths resolve from cwd. If omitted, outputs/browser is used."),
  full: optionalBoolean("Capture full page."),
  annotate: optionalBoolean("Annotate screenshot with numbered element labels."),
  format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], { description: "Screenshot format." })),
  quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "JPEG quality 0-100." })),
}));

const EvalSchema = Type.Object(commonSchema({
  javascript: Type.String({ description: "JavaScript expression or script passed to agent-browser eval." }),
  outputPath: optionalString("Optional path to save stdout. Relative paths resolve from cwd."),
}));

const CloseSchema = Type.Object(commonSchema({
  all: optionalBoolean("Close all active agent-browser sessions."),
}));

const StateSchema = Type.Object(commonSchema({
  operation: Type.Union([
    Type.Literal("save"),
    Type.Literal("load"),
    Type.Literal("list"),
    Type.Literal("show"),
    Type.Literal("rename"),
    Type.Literal("clear"),
    Type.Literal("clean"),
  ], { description: "State operation: save/load/list/show/rename/clear/clean." }),
  path: optionalString("Path for save/load operations."),
  filename: optionalString("Saved state filename for show."),
  oldName: optionalString("Old saved state name for rename."),
  newName: optionalString("New saved state name for rename."),
  sessionName: optionalString("Session name for clear. Distinct from global session to match agent-browser state clear [session-name]."),
  all: optionalBoolean("Clear all saved states for operation=clear."),
  olderThanDays: Type.Optional(Type.Integer({ minimum: 1, description: "Delete saved states older than this many days for operation=clean." })),
  json: optionalBoolean("Forward --json for machine-readable state output."),
}));

const HandoffSchema = Type.Object(commonSchema({
  category: Type.Union(
    [Type.Literal("2fa"), Type.Literal("captcha"), Type.Literal("identity_verification"), Type.Literal("other")],
    { description: "Why AI control must pause: 2fa, captcha, identity_verification, or other." },
  ),
  reason: Type.String({ description: "Concise description of what the human must do (e.g. 'Enter the SMS code sent to the user\\'s phone')." }),
  screenshot: optionalBoolean("Capture a screenshot for the human before waiting. Defaults to true."),
}));

const LoginHandoffSchema = Type.Object({
  url: Type.String({ description: "Login/app URL to open in a real, non-automated browser for the human to sign in." }),
  session: optionalString("agent-browser session name to attach as after login completes. Defaults to the default session."),
  reason: Type.String({ description: "Human-readable reason for the login handoff (e.g. 'Googleアカウントへのログインが必要です')." }),
  executablePath: optionalString("Override path to a real Chrome executable. Auto-detected on macOS if omitted."),
  profileDir: optionalString("Override persistent user-data-dir for the login browser. Defaults to a per-session directory reused across runs so re-running the same session reuses the same authenticated profile."),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Tool execution timeout in milliseconds for the post-login attach step." })),
});

const CommitSchema = Type.Object(commonSchema({
  selector: Type.String({ description: "Element ref from snapshot, such as @e2, or a CSS selector, for the irreversible action (e.g. final pay/post/delete button)." }),
  summary: Type.String({ description: "Plain-language description of what this click will do, e.g. '¥12,000 の決済を確定する' or 'この投稿を完全に削除する'." }),
  riskCategory: Type.Union(
    [Type.Literal("payment"), Type.Literal("delete"), Type.Literal("post_publish"), Type.Literal("send"), Type.Literal("other")],
    { description: "Category of irreversible action: payment, delete, post_publish, send, or other." },
  ),
  screenshot: optionalBoolean("Capture a screenshot as evidence before asking for confirmation. Defaults to true."),
}));

const DoctorSchema = Type.Object({
  fix: optionalBoolean("Run agent-browser doctor --fix."),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Tool execution timeout in milliseconds." })),
});

async function findAgentBrowserBin(): Promise<string> {
  if (process.env.AGENT_BROWSER_BIN) return process.env.AGENT_BROWSER_BIN;
  const candidates = [
    "/Users/tadano-go/.local/bin/agent-browser",
    join(process.env.HOME ?? "", ".local/bin/agent-browser"),
    "agent-browser",
  ];

  for (const candidate of candidates) {
    if (candidate === "agent-browser") return candidate;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return "agent-browser";
}

function findRealChromeExecutable(): string | undefined {
  const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(macPath)) return macPath;
  return undefined;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (port) resolvePort(port);
        else reject(new Error("Could not determine a free port."));
      });
    });
  });
}

function killPidBestEffort(pid?: number): void {
  if (!pid) return;
  try { process.kill(pid); } catch { /* already gone / not ours */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = no-op existence/permission check, does not actually kill
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"; // ESRCH = no such process (dead); any other error (e.g. EPERM) means it exists
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    if (signal?.aborted) {
      resolveDelay();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolveDelay();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForDebugPort(port: number, timeoutMs = 8000, intervalMs = 300, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      // Not up yet; keep polling.
    }
    if (signal?.aborted) return false;
    await abortableDelay(intervalMs, signal);
  }
  return false;
}

function pushCommonArgs(args: string[], params: JsonObject): void {
  if (typeof params.session === "string" && params.session.trim()) {
    args.push("--session", params.session.trim());
  }
  if (Array.isArray(params.allowedDomains) && params.allowedDomains.length > 0) {
    args.push("--allowed-domains", params.allowedDomains.map(String).join(","));
  }
  if (typeof params.maxOutput === "number" && Number.isFinite(params.maxOutput)) {
    args.push("--max-output", String(Math.floor(params.maxOutput)));
  }
}

function pushExtraArgs(args: string[], params: JsonObject): void {
  if (Array.isArray(params.extraArgs)) {
    for (const arg of params.extraArgs) args.push(String(arg));
  }
}

async function runAgentBrowser(args: string[], options: { signal?: AbortSignal; timeoutMs?: number; cwd: string; onUpdate?: AgentToolUpdateCallback<ToolDetails> }): Promise<RunResult> {
  const command = await findAgentBrowserBin();
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await new Promise<RunResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });

    const timeout = setTimeout(() => {
      if (!settled) {
        stderr += `\nTimed out after ${timeoutMs}ms.`;
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        ok: false,
        command,
        args,
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + error.message,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        ok: exitCode === 0,
        command,
        args,
        stdout,
        stderr,
        exitCode,
        signal,
        durationMs: Date.now() - started,
      });
    });
  });
}

function resolveOutputPath(ctx: ExtensionContext, requested: unknown, fallbackName: string): string {
  if (typeof requested === "string" && requested.trim()) {
    const p = requested.trim();
    return p.startsWith("/") ? p : resolve(ctx.cwd, p);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(ctx.cwd, DEFAULT_ARTIFACT_DIR, `${stamp}-${fallbackName}`);
}

async function saveArtifact(path: string, content: string): Promise<string> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

function preview(text: string, maxChars = DEFAULT_MAX_PREVIEW_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + `\n\n[truncated: ${text.length - maxChars} chars omitted]`, truncated: true };
}

function buildTextResult(result: RunResult, artifactPaths: string[] = [], parsedJson?: unknown, notes: string[] = []): { content: { type: "text"; text: string }[]; details: ToolDetails } {
  const stdoutPreview = preview(result.stdout.trim());
  const stderrPreview = preview(result.stderr.trim(), 4000);
  const lines = [
    ...notes,
    result.ok ? "agent-browser command succeeded." : "agent-browser command failed.",
    `Command: ${result.command} ${result.args.map((a) => JSON.stringify(a)).join(" ")}`,
    `Exit: ${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}`,
    `Duration: ${result.durationMs}ms`,
  ];
  if (artifactPaths.length > 0) {
    lines.push("Artifacts:");
    for (const p of artifactPaths) lines.push(`- ${p}`);
  }
  if (stdoutPreview.text) {
    lines.push("Stdout:", stdoutPreview.text);
  }
  if (stderrPreview.text) {
    lines.push("Stderr:", stderrPreview.text);
  }
  if (stdoutPreview.truncated) {
    lines.push("Stdout preview was truncated. Read the artifact path or rerun with outputPath for full output.");
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { ...result, artifactPaths, parsedJson },
  };
}

function sensitiveContentNotes(hits: string[]): string[] {
  if (hits.length === 0) return [];
  return [
    `⚠ Possible human-only checkpoint detected: ${hits.join(", ")}.`,
    "Do not attempt to click/fill through this yourself — call agent_browser_handoff first so a human can complete it.",
    "",
  ];
}

function parseJsonIfRequested(result: RunResult, requested: boolean): unknown | undefined {
  if (!requested || !result.stdout.trim()) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent_browser_open",
    label: "Agent Browser Open",
    description: "Open a URL or launch an agent-browser controlled browser session. Wraps vercel-labs/agent-browser CLI.",
    promptSnippet: "Use agent_browser_open to launch/navigate browser pages when rendered interaction is needed.",
    promptGuidelines: [
      "Use agent_browser_snapshot after opening or navigating before clicking by @ref.",
      "Pass allowedDomains for untrusted or task-scoped browsing when possible.",
      "Prefer headed: true whenever the task might hit a login, 2FA, CAPTCHA, or identity-verification step — a human can only intervene through agent_browser_handoff if a visible window already exists.",
    ],
    parameters: OpenSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args: string[] = [];
      pushCommonArgs(args, params);
      if (params.headed === true) args.push("--headed");
      if (typeof params.profile === "string" && params.profile.trim()) args.push("--profile", params.profile.trim());
      if (params.restore === true) {
        args.push("--restore");
      } else if (typeof params.restore === "string" && params.restore.trim()) {
        const restore = params.restore.trim();
        if (restore.toLowerCase() === "true") args.push("--restore");
        else if (restore.toLowerCase() !== "false") args.push("--restore", restore);
      }
      args.push("open");
      if (typeof params.url === "string" && params.url.trim()) args.push(params.url.trim());
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      if (result.ok) {
        await writeSessionState(ctx.cwd, sessionKey(params), {
          headed: params.headed === true,
          lastUrl: typeof params.url === "string" && params.url.trim() ? params.url.trim() : undefined,
        });
      }
      return buildTextResult(result);
    },
  });

  pi.registerTool({
    name: "agent_browser_read",
    label: "Agent Browser Read",
    description: "Extract agent-readable text or JSON from a URL or the active rendered tab using agent-browser read.",
    promptSnippet: "Use agent_browser_read for browser-backed or markdown-aware web context extraction. Save long outputs with outputPath.",
    promptGuidelines: [
      "Prefer agent_browser_read over screenshot OCR when text extraction is enough.",
      "Use outputPath for durable source artifacts when extracted content will support a report.",
    ],
    parameters: ReadSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("read");
      if (typeof params.url === "string" && params.url.trim()) args.push(params.url.trim());
      if (params.json === true) args.push("--json");
      if (params.raw === true) args.push("--raw");
      if (params.outline === true) args.push("--outline");
      if (params.requireMd === true) args.push("--require-md");
      if (typeof params.filter === "string" && params.filter.trim()) args.push("--filter", params.filter.trim());
      if (params.llms === "index" || params.llms === "full") args.push("--llms", params.llms);
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      const artifacts: string[] = [];
      if (typeof params.outputPath === "string" && params.outputPath.trim()) {
        artifacts.push(await saveArtifact(resolveOutputPath(ctx, params.outputPath, "read.txt"), result.stdout));
      }
      const hits = scanForSensitiveContent(result.stdout);
      const { content, details } = buildTextResult(result, artifacts, parseJsonIfRequested(result, params.json === true), sensitiveContentNotes(hits));
      return { content, details: { ...details, securityFlags: hits } };
    },
  });

  pi.registerTool({
    name: "agent_browser_snapshot",
    label: "Agent Browser Snapshot",
    description: "Get an accessibility snapshot with stable refs for browser interaction.",
    promptSnippet: "Use agent_browser_snapshot before clicks/fills to get fresh @refs.",
    promptGuidelines: ["Refs can go stale after navigation or DOM changes. Take a fresh snapshot before retrying failed clicks."],
    parameters: SnapshotSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("snapshot");
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      const artifacts: string[] = [];
      if (typeof params.outputPath === "string" && params.outputPath.trim()) {
        artifacts.push(await saveArtifact(resolveOutputPath(ctx, params.outputPath, "snapshot.txt"), result.stdout));
      }
      const hits = scanForSensitiveContent(result.stdout);
      const { content, details } = buildTextResult(result, artifacts, undefined, sensitiveContentNotes(hits));
      return { content, details: { ...details, securityFlags: hits } };
    },
  });

  pi.registerTool({
    name: "agent_browser_click",
    label: "Agent Browser Click",
    description: "Click an element by agent-browser @ref or CSS selector.",
    promptSnippet: "Use agent_browser_click with @refs from agent_browser_snapshot or CSS selectors.",
    promptGuidelines: ["If a click fails because an element covers the target, inspect the error, dismiss the covering element, and take a fresh snapshot."],
    parameters: ClickSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("click", String(params.selector));
      if (params.newTab === true) args.push("--new-tab");
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      return buildTextResult(result);
    },
  });

  pi.registerTool({
    name: "agent_browser_fill",
    label: "Agent Browser Fill",
    description: "Clear and fill an input element by agent-browser @ref or CSS selector.",
    promptSnippet: "Use agent_browser_fill for form inputs after identifying refs with agent_browser_snapshot.",
    parameters: FillSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("fill", String(params.selector), String(params.text));
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      return buildTextResult(result);
    },
  });

  pi.registerTool({
    name: "agent_browser_screenshot",
    label: "Agent Browser Screenshot",
    description: "Capture a browser screenshot and return the saved artifact path.",
    promptSnippet: "Use agent_browser_screenshot for visual evidence, UI QA, or pages where text extraction is insufficient.",
    parameters: ScreenshotSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const path = resolveOutputPath(ctx, params.path, "screenshot.png");
      await mkdir(resolve(path, ".."), { recursive: true });
      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("screenshot", path);
      if (params.full === true) args.push("--full");
      if (params.annotate === true) args.push("--annotate");
      if (params.format === "png" || params.format === "jpeg") args.push("--screenshot-format", params.format);
      if (typeof params.quality === "number" && Number.isFinite(params.quality)) args.push("--screenshot-quality", String(Math.floor(params.quality)));
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      const artifacts = existsSync(path) ? [path] : [];
      return buildTextResult(result, artifacts);
    },
  });

  pi.registerTool({
    name: "agent_browser_eval",
    label: "Agent Browser Eval",
    description: "Evaluate JavaScript in the active browser tab via agent-browser eval.",
    promptSnippet: "Use agent_browser_eval for precise DOM extraction or browser-side state checks when read/snapshot are insufficient.",
    promptGuidelines: ["Do not use eval to bypass site security or perform destructive actions. Prefer read/snapshot for ordinary extraction."],
    parameters: EvalSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("eval", String(params.javascript));
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      const artifacts: string[] = [];
      if (typeof params.outputPath === "string" && params.outputPath.trim()) {
        artifacts.push(await saveArtifact(resolveOutputPath(ctx, params.outputPath, "eval.txt"), result.stdout));
      }
      return buildTextResult(result, artifacts);
    },
  });

  pi.registerTool({
    name: "agent_browser_state",
    label: "Agent Browser State",
    description: "Save, load, list, show, rename, clear, or clean agent-browser saved state such as cookies and web storage.",
    promptSnippet: "Use agent_browser_state to persist or clear login/browser state when sessions and restore are involved.",
    promptGuidelines: [
      "Use operation=list before destructive clear/clean operations unless the user explicitly asks to clear everything.",
      "Use session + restore on agent_browser_open for automatic state persistence; use state save/load for explicit files.",
      "Do not clear all saved states unless the user clearly asks for global cleanup.",
    ],
    parameters: StateSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args: string[] = [];
      pushCommonArgs(args, params);
      if (params.json === true) args.push("--json");
      args.push("state");
      const operation = String(params.operation);
      args.push(operation);

      if ((operation === "save" || operation === "load") && typeof params.path === "string" && params.path.trim()) {
        args.push(params.path.trim());
      } else if (operation === "show" && typeof params.filename === "string" && params.filename.trim()) {
        args.push(params.filename.trim());
      } else if (operation === "rename" && typeof params.oldName === "string" && typeof params.newName === "string" && params.oldName.trim() && params.newName.trim()) {
        args.push(params.oldName.trim(), params.newName.trim());
      } else if (operation === "clear") {
        if (typeof params.sessionName === "string" && params.sessionName.trim()) args.push(params.sessionName.trim());
        if (params.all === true) args.push("--all");
      } else if (operation === "clean" && typeof params.olderThanDays === "number" && Number.isFinite(params.olderThanDays)) {
        args.push("--older-than", String(Math.floor(params.olderThanDays)));
      }

      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      return buildTextResult(result, [], parseJsonIfRequested(result, params.json === true));
    },
  });

  pi.registerTool({
    name: "agent_browser_close",
    label: "Agent Browser Close",
    description: "Close the active agent-browser session or all sessions.",
    promptSnippet: "Use agent_browser_close to clean up browser sessions after automation.",
    parameters: CloseSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const states = await readSessionStates(ctx.cwd);
      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("close");
      if (params.all === true) args.push("--all");
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });

      // agent-browser close only detaches an externally-spawned login Chrome; kill the tracked pid(s) ourselves.
      if (params.all === true) {
        for (const [name, st] of Object.entries(states)) {
          if (!st.loginBrowserPid) continue;
          killPidBestEffort(st.loginBrowserPid);
          await writeSessionState(ctx.cwd, name, { clearLoginBrowserPid: true });
        }
      } else {
        const session = sessionKey(params);
        if (states[session]?.loginBrowserPid) {
          killPidBestEffort(states[session]?.loginBrowserPid);
          await writeSessionState(ctx.cwd, session, { clearLoginBrowserPid: true });
        }
      }
      return buildTextResult(result);
    },
  });

  pi.registerTool({
    name: "agent_browser_handoff",
    label: "Agent Browser Handoff",
    description: "Pause AI control and hand the browser to a human for steps AI cannot or must not perform: 2FA codes, CAPTCHA, identity verification. Blocks until the human confirms completion or aborts.",
    promptSnippet: "Call agent_browser_handoff and stop acting on the page whenever a 2FA/CAPTCHA/identity-verification checkpoint blocks progress.",
    promptGuidelines: [
      "Never attempt to solve CAPTCHAs, guess 2FA/OTP codes, or fabricate identity-verification data yourself.",
      "Call this tool as soon as such a checkpoint appears; do not keep clicking or filling around it.",
      "If the tool reports no interactive UI is available, stop the task and tell the operator to rerun it interactively.",
    ],
    parameters: HandoffSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const category = String(params.category);
      const reason = String(params.reason);
      const artifacts: string[] = [];
      const session = sessionKey(params);
      const sessionState = (await readSessionStates(ctx.cwd))[session];
      const headlessNotes = sessionState?.headed === true ? [] : reopenHeadedGuidance(session, sessionState?.lastUrl);

      if (params.screenshot !== false) {
        const path = resolveOutputPath(ctx, undefined, "handoff.png");
        await mkdir(resolve(path, ".."), { recursive: true });
        const shotArgs: string[] = [];
        pushCommonArgs(shotArgs, params);
        shotArgs.push("screenshot", path);
        await runAgentBrowser(shotArgs, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
        if (existsSync(path)) artifacts.push(path);
      }

      if (!ctx.hasUI) {
        return {
          content: [{
            type: "text",
            text: [
              `Human handoff required (${category}) but no interactive UI is available in this run mode.`,
              `Reason: ${reason}`,
              artifacts.length ? `Evidence: ${artifacts.join(", ")}` : undefined,
              ...headlessNotes,
              "Stop this task now and ask the operator to rerun it interactively so the handoff can be completed.",
            ].filter(Boolean).join("\n"),
          }],
          details: { ok: false, command: "handoff", args: [category], stdout: "", stderr: "no interactive UI", exitCode: null, signal: null, durationMs: 0, artifactPaths: artifacts },
          terminate: true,
        };
      }

      if (headlessNotes.length) ctx.ui.notify(headlessNotes.join(" "), "warning");
      ctx.ui.notify(`Human handoff needed (${category}): ${reason}`, "warning");
      ctx.ui.setStatus("agent-browser-handoff", headlessNotes.length ? `⏸ ブラウザ非表示 — ${reason}` : `⏸ Waiting for human: ${reason}`);
      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(
          `Human handoff required (${category}): ${reason}`,
          ["Resume - I completed this manually", "Abort this task"],
        );
      } finally {
        ctx.ui.setStatus("agent-browser-handoff", undefined);
      }

      const resumed = choice === "Resume - I completed this manually";
      return {
        content: [{
          type: "text",
          text: [
            ...headlessNotes,
            resumed
              ? "Human confirmed the handoff step is complete. Take a fresh agent_browser_snapshot before continuing."
              : "Human aborted the task during handoff. Stop and report back; do not retry automatically.",
            artifacts.length ? `Evidence captured: ${artifacts.join(", ")}` : undefined,
          ].filter(Boolean).join("\n"),
        }],
        details: { ok: resumed, command: "handoff", args: [category], stdout: choice ?? "", stderr: "", exitCode: resumed ? 0 : 1, signal: null, durationMs: 0, artifactPaths: artifacts },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "agent_browser_login_handoff",
    label: "Agent Browser Login Handoff",
    description: "Launch a real, non-CDP-attached Chrome for an interactive login (e.g. Google sign-in) that automation frameworks get blocked from. Once the human confirms login is complete, live-attaches that still-running browser to the named agent-browser session and keeps it open as the session's backing browser (no cookie/state export). Blocks until the human confirms or aborts.",
    promptSnippet: "Use agent_browser_login_handoff (not agent_browser_open) whenever a task requires an interactive Google/OAuth-style login.",
    promptGuidelines: [
      "Never attempt an interactive Google/OAuth-style login via agent_browser_open, agent_browser_click, or agent_browser_fill — those attach CDP immediately, and Google blocks sign-in for CDP-attached sessions regardless of profile or cookies.",
      "Call this tool instead whenever a task is expected to require signing into a Google account or a similarly automation-hostile login flow.",
      "After this tool reports success, take a fresh agent_browser_snapshot before continuing — do not assume page state.",
      "On success the login browser stays open and IS the session's live backing browser; drive it with the normal agent_browser_* tools by session name, and call agent_browser_close when done to shut it down (it holds an open remote-debugging port until then).",
      "If this tool reports no interactive UI, a decline, or a failure, stop the task and report back; do not retry via agent_browser_open.",
    ],
    parameters: LoginHandoffSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const url = String(params.url);
      const reason = String(params.reason);
      const session = sessionKey(params);

      const executablePath = typeof params.executablePath === "string" && params.executablePath.trim()
        ? params.executablePath.trim()
        : findRealChromeExecutable();

      if (!executablePath) {
        return {
          content: [{
            type: "text",
            text: [
              "Could not find a real Chrome executable for the login handoff.",
              "Auto-detection only checks the default macOS install path (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome).",
              "Pass executablePath explicitly, or install Google Chrome, and retry. Do not fall back to agent-browser's bundled test browser — it will be blocked by Google the same way.",
            ].join("\n"),
          }],
          details: { ok: false, command: "login-handoff", args: [], stdout: "", stderr: "no chrome executable found", exitCode: null, signal: null, durationMs: 0 },
          terminate: true,
        };
      }

      const profileDir = typeof params.profileDir === "string" && params.profileDir.trim()
        ? params.profileDir.trim()
        : join(ctx.cwd, SESSION_STATE_DIR, "login-profiles", session);
      await mkdir(profileDir, { recursive: true });

      const port = await findFreePort();

      // Supersede an older live login browser for this session so re-running doesn't leak it.
      const prior = (await readSessionStates(ctx.cwd))[session];
      killPidBestEffort(prior?.loginBrowserPid);

      let spawnError: Error | undefined;
      const child = spawn(executablePath, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        url,
      ], { detached: true, stdio: "ignore" });
      // Persistent handler: without this, an 'error' event (e.g. ENOENT for a bad
      // executablePath) on this detached/unref'd child is unhandled and crashes the
      // whole host process whenever it fires, even long after this tool call returns.
      child.on("error", (error) => {
        spawnError = error;
      });
      child.unref();

      const debugPortWaitController = new AbortController();
      const debugPortUp = spawnError ? false : await Promise.race([
        waitForDebugPort(port, undefined, undefined, debugPortWaitController.signal),
        new Promise<boolean>((resolveRace) => {
          child.once("error", () => resolveRace(false));
        }),
      ]);
      // Whichever branch lost the race must stop polling promptly instead of
      // holding the event loop open for its own full timeout in the background.
      debugPortWaitController.abort();
      if (spawnError || !debugPortUp) {
        try { child.kill(); } catch { /* best-effort */ }
        return {
          content: [{
            type: "text",
            text: [
              spawnError
                ? `Failed to launch the login browser: ${spawnError.message}`
                : `Failed to confirm the login browser's debug port (127.0.0.1:${port}) came up in time.`,
              `Attempted to launch: ${executablePath}`,
              "The login browser was not confirmed usable; it has been asked to close. Stop and report back.",
            ].join("\n"),
          }],
          details: { ok: false, command: "login-handoff", args: [executablePath, url], stdout: "", stderr: spawnError ? spawnError.message : "debug port did not come up", exitCode: null, signal: null, durationMs: 0 },
          terminate: true,
        };
      }

      if (!ctx.hasUI) {
        try { child.kill(); } catch { /* best-effort */ }
        return {
          content: [{
            type: "text",
            text: [
              "Login handoff required but no interactive UI is available in this run mode.",
              `Reason: ${reason}`,
              "The login browser has been closed. Stop this task now and ask the operator to rerun it interactively so the login can be completed.",
            ].join("\n"),
          }],
          details: { ok: false, command: "login-handoff", args: [executablePath, url], stdout: "", stderr: "no interactive UI", exitCode: null, signal: null, durationMs: 0 },
          terminate: true,
        };
      }

      ctx.ui.notify(`Login handoff needed: ${reason}`, "warning");
      ctx.ui.setStatus("agent-browser-login-handoff", `⏸ ログイン待機中 — ${reason}`);
      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(
          `Login required: ${reason}`,
          ["Resume - I completed the login", "Abort this task"],
        );
      } finally {
        ctx.ui.setStatus("agent-browser-login-handoff", undefined);
      }

      if (choice !== "Resume - I completed the login") {
        try { child.kill(); } catch { /* best-effort */ }
        return {
          content: [{
            type: "text",
            text: "Human aborted the task during login handoff. Stop and report back; do not retry automatically.",
          }],
          details: { ok: false, command: "login-handoff", args: [executablePath, url], stdout: choice ?? "", stderr: "", exitCode: 1, signal: null, durationMs: 0 },
          terminate: true,
        };
      }

      // Human confirmed login. Bind the STILL-RUNNING login Chrome into the named session
      // via CDP, WITHOUT navigating (snapshot binds + verifies in one shot; open would
      // re-navigate away from the authenticated landing page). Keep the browser ALIVE —
      // it is now the backing browser this session drives from here on.

      // Defensive: surface multi-tab situations (OAuth popups) without failing.
      const tabArgs = ["--cdp", String(port), "tab", "list"];
      const tabResult = await runAgentBrowser(tabArgs, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });

      const bindArgs = ["--session", session, "--cdp", String(port), "snapshot"];
      const result = await runAgentBrowser(bindArgs, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });

      if (!result.ok) {
        // Bind failed: the login browser is still alive but unusable by the session.
        // Best-effort kill so we don't leak a debug-port Chrome, and report.
        killPidBestEffort(child.pid);
        return {
          content: [{
            type: "text",
            text: [
              "Human confirmed login, but attaching the live browser to the agent-browser session failed. Do not assume the session is usable.",
              `Command: ${result.command} ${result.args.map((a) => JSON.stringify(a)).join(" ")}`,
            ].join("\n"),
          }],
          details: { ...result, artifactPaths: [] },
          terminate: true,
        };
      }

      // Persist backing-browser identity + the fact that a VISIBLE window exists (headed:true).
      await writeSessionState(ctx.cwd, session, {
        headed: true,
        lastUrl: url,
        loginBrowserPid: child.pid,
        loginDebugPort: port,
      });

      // Surface other still-live login browsers so they don't go unnoticed between
      // agent_browser_doctor runs (same isPidAlive/cleanup semantics as doctor).
      const otherLiveBrowsers: { session: string; pid: number }[] = [];
      for (const [otherSession, otherState] of Object.entries(await readSessionStates(ctx.cwd))) {
        if (otherSession === session || !otherState.loginBrowserPid) continue;
        if (!isPidAlive(otherState.loginBrowserPid)) {
          await writeSessionState(ctx.cwd, otherSession, { clearLoginBrowserPid: true });
          continue;
        }
        otherLiveBrowsers.push({ session: otherSession === DEFAULT_SESSION_KEY ? "(default)" : otherSession, pid: otherState.loginBrowserPid });
      }

      const multiTab = /\bt2\b/.test(tabResult.stdout) || (tabResult.stdout.match(/\[t\d+\]/g)?.length ?? 0) > 1;
      return {
        content: [{
          type: "text",
          text: [
            "Login handoff complete: the browser you signed in with is now live-attached to the agent-browser session and stays open.",
            `Session: ${session === DEFAULT_SESSION_KEY ? "(default)" : session}`,
            multiTab ? `Note: multiple tabs are open — verify the active tab before acting:\n${tabResult.stdout.trim()}` : undefined,
            "The session drives this real browser window directly. Take a fresh agent_browser_snapshot before continuing.",
            "This login browser has an open remote-debugging port and will stay open until agent_browser_close is called for this session (or the window is closed manually).",
            otherLiveBrowsers.length > 0
              ? `Also still open: ${otherLiveBrowsers.map((b) => `${b.session} (pid ${b.pid})`).join(", ")}. Call agent_browser_close for each when done, or run agent_browser_doctor for full details.`
              : undefined,
          ].filter(Boolean).join("\n"),
        }],
        details: { ...result, artifactPaths: [] },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "agent_browser_commit",
    label: "Agent Browser Commit",
    description: "Gate for irreversible actions (payment, delete, publish/post, send). Captures evidence, requires explicit human confirmation, then performs the click. Never bypassed for unattended runs.",
    promptSnippet: "Use agent_browser_commit instead of agent_browser_click for the final step of any irreversible action (pay, delete, publish, send).",
    promptGuidelines: [
      "Route the final confirming click of a payment, deletion, publish/post, or send action through this tool, never agent_browser_click.",
      "Write summary in plain language describing exactly what will happen, including amounts or targets when known.",
      "If this tool reports the human declined or no UI was available, stop and report back — do not retry the click through agent_browser_click.",
    ],
    parameters: CommitSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const selector = String(params.selector);
      const summary = String(params.summary);
      const riskCategory = String(params.riskCategory);
      const artifacts: string[] = [];

      if (params.screenshot !== false) {
        const path = resolveOutputPath(ctx, undefined, "commit-evidence.png");
        await mkdir(resolve(path, ".."), { recursive: true });
        const shotArgs: string[] = [];
        pushCommonArgs(shotArgs, params);
        shotArgs.push("screenshot", path);
        await runAgentBrowser(shotArgs, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
        if (existsSync(path)) artifacts.push(path);
      }

      if (!ctx.hasUI) {
        return {
          content: [{
            type: "text",
            text: [
              `Irreversible action blocked (${riskCategory}): no interactive UI available to confirm with a human.`,
              `Action: ${summary}`,
              artifacts.length ? `Evidence: ${artifacts.join(", ")}` : undefined,
              "The click was NOT performed. Stop this task and ask the operator to rerun it interactively.",
            ].filter(Boolean).join("\n"),
          }],
          details: { ok: false, command: "commit", args: [riskCategory, selector], stdout: "", stderr: "no interactive UI", exitCode: null, signal: null, durationMs: 0, artifactPaths: artifacts },
          terminate: true,
        };
      }

      ctx.ui.notify(`Confirmation needed for irreversible action (${riskCategory}): ${summary}`, "warning");
      const approved = await ctx.ui.confirm(
        `Confirm irreversible action (${riskCategory})`,
        `${summary}\n\nTarget: ${selector}\nThis cannot be undone. Proceed?`,
      );

      if (!approved) {
        return {
          content: [{
            type: "text",
            text: [
              "Human declined the irreversible action. The click was NOT performed.",
              `Action: ${summary}`,
              artifacts.length ? `Evidence captured before decline: ${artifacts.join(", ")}` : undefined,
              "Stop and report back; do not retry this action automatically.",
            ].filter(Boolean).join("\n"),
          }],
          details: { ok: false, command: "commit", args: [riskCategory, selector], stdout: "declined", stderr: "", exitCode: 1, signal: null, durationMs: 0, artifactPaths: artifacts },
          terminate: true,
        };
      }

      const args: string[] = [];
      pushCommonArgs(args, params);
      args.push("click", selector);
      pushExtraArgs(args, params);
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      return buildTextResult(result, artifacts);
    },
  });

  pi.registerTool({
    name: "agent_browser_doctor",
    label: "Agent Browser Doctor",
    description: "Run agent-browser doctor to verify installation, Chrome, daemon, security, providers, network, and launch tests. Also reports and cleans up tracked login-handoff browsers (see agent_browser_login_handoff).",
    promptSnippet: "Use agent_browser_doctor when browser automation fails or before relying on agent-browser in a workflow. It also flags any live login-handoff browsers left open and cleans up stale tracking entries.",
    parameters: DoctorSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as JsonObject;
      const args = ["doctor"];
      if (params.fix === true) args.push("--fix");
      const result = await runAgentBrowser(args, { signal, timeoutMs: params.timeoutMs as number | undefined, cwd: ctx.cwd, onUpdate });
      const textResult = buildTextResult(result);

      const states = await readSessionStates(ctx.cwd);
      const liveBrowsers: { session: string; pid: number; port: number | undefined; lastUrl?: string }[] = [];
      for (const [session, state] of Object.entries(states)) {
        if (!state.loginBrowserPid) continue;
        if (!isPidAlive(state.loginBrowserPid)) {
          await writeSessionState(ctx.cwd, session, { clearLoginBrowserPid: true });
          continue;
        }
        liveBrowsers.push({
          session: session === DEFAULT_SESSION_KEY ? "(default)" : session,
          pid: state.loginBrowserPid,
          port: state.loginDebugPort,
          lastUrl: state.lastUrl,
        });
      }

      if (liveBrowsers.length > 0) {
        const lines = [
          "",
          "Live login browsers (from agent_browser_login_handoff) still open:",
          ...liveBrowsers.map((b) => `- ${b.session}: pid ${b.pid}, debug port ${b.port ?? "?"}${b.lastUrl ? `, last url ${b.lastUrl}` : ""}`),
          "Call agent_browser_close for each session when done — these hold an open remote-debugging port until closed.",
        ];
        textResult.content[0].text += lines.join("\n");
      }

      return textResult;
    },
  });
}
