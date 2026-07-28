---
name: agent-browser
description: Use vercel-labs/agent-browser from Pi for browser automation, rendered-page interaction, screenshots, and agent-readable web context extraction. Use when a task requires interacting with a website, reading authenticated/rendered DOM state, capturing visual evidence, or extracting page context beyond simple HTTP fetch.
---

# Agent Browser for Pi

Use the `agent_browser_*` tools instead of raw `bash` commands when browser state, screenshots, or structured artifacts matter.

## Core workflow

1. Open or navigate with `agent_browser_open`.
2. Extract text with `agent_browser_read` when text is enough.
3. Use `agent_browser_snapshot` before interactive actions to get fresh `@ref` identifiers.
4. Use `agent_browser_click` and `agent_browser_fill` with `@ref` values from the latest snapshot.
5. Capture evidence with `agent_browser_screenshot` when layout or visual state matters.
6. Persist or clear login/browser state with `agent_browser_state` when needed.
7. Close sessions with `agent_browser_close` when finished.

## Safety defaults

- Pass `allowedDomains` whenever the browsing task has a known scope.
- Use `outputPath` for durable source artifacts that support reports or later verification.
- Take a fresh snapshot after navigation, form submission, modal dismissal, or any failed click.
- Prefer `agent_browser_read` over screenshots for textual evidence.
- Use `agent_browser_eval` only when read/snapshot cannot expose the required state.
- To keep login state automatically, open with a stable `session` and `restore: true`.
- Before clearing state, list saved states with `agent_browser_state` unless the user explicitly asks for broad cleanup.

## Human handoff and commit gates

Two tools exist so the agent stops and hands control back to a human instead of guessing through security or irreversible steps:

- `agent_browser_handoff` — call this the moment 2FA/OTP entry, a CAPTCHA, or identity verification blocks progress. It captures a screenshot, then blocks (via a real UI dialog) until a human resumes or aborts. Never try to solve CAPTCHAs, guess codes, or fabricate identity data yourself.
- `agent_browser_commit` — use this instead of `agent_browser_click` for the final confirming click of any irreversible action: payment, deletion, publish/post, send. It captures evidence, requires explicit human confirmation, and only clicks if approved. If no interactive UI is available, it refuses and does not click.

`agent_browser_read` and `agent_browser_snapshot` also run a lightweight heuristic scan for 2FA/CAPTCHA/identity-verification keywords and prepend a warning to their output when detected — treat that warning as a signal to call `agent_browser_handoff` next, not as a blocker by itself.

On resume, `agent_browser_handoff` does not force the agent to stop and wait for a new user turn — the checkpoint is cleared, so continue the original task right away (after a fresh `agent_browser_snapshot`). Only abort ends the turn, since that's a genuine dead end needing a human/operator decision.

### If the human can't find the browser window

`agent_browser_open` records whether each named session was launched with `headed: true`. When `agent_browser_handoff` runs for a session that was not opened headed, it automatically prepends a warning naming the session and the exact `agent_browser_open` arguments (including the last known URL) needed to reopen it visibly, instead of leaving the human to guess. Prefer `headed: true` from the start for any task that might hit a login, 2FA, CAPTCHA, or identity-verification step — a human can only intervene through `agent_browser_handoff` if a visible window already exists. Note that some verification challenges are single-use or session-bound, so reopening may require restarting the login flow rather than resuming mid-challenge.

### For interactive login flows (Google, OAuth, and similar)

`agent_browser_login_handoff` solves a specific problem: Google and similar OAuth providers block sign-in when `agent-browser open` is used, because agent-browser attaches a remote debugging protocol (CDP) session the instant Chrome launches, and Google detects this automation marker and rejects the login attempt regardless of profile, cookies, or executable.

This tool spawns a plain, un-instrumented Chrome process (not through `agent-browser open`) with a remote debugging port and a dedicated persistent profile, so no CDP client is attached while the human logs in. Chrome behaves like an ordinary browser to Google during sign-in. After the human confirms login is complete, the still-running login browser is **live-attached to the named agent-browser session** (via `agent-browser --session <name> --cdp <port> snapshot`, not `open`, to avoid navigating away from the authenticated page) and **kept open as the permanent backing browser for that session**. All subsequent automated snapshot, read, click, and other operations continue to work against it via `--session <name>` alone, unchanged.

**Important:** this is an architecture fix, not detection evasion. The tool does not hide webdriver flags or automation fingerprints — it simply avoids having a CDP session attached during the interactive login moment itself.

Use `agent_browser_login_handoff` instead of `agent_browser_open` for any task expected to hit an interactive Google, OAuth, or similar sign-in flow. Never try to push through such a login via `agent_browser_open` + click/fill — that's the exact failure mode this tool exists to avoid.

Example call:

```json
{
  "url": "https://myapp.com/login",
  "session": "google-oauth-flow",
  "reason": "User must complete Google OAuth sign-in for app access"
}
```

After the human confirms login is complete, subsequent `agent_browser_open`, `agent_browser_snapshot`, `agent_browser_click`, and other calls with the same `session` name will reuse the authenticated browser and operate normally. **The login browser window remains visible and open indefinitely** — this is a real, user-visible Chrome window with an open remote-debugging port on `127.0.0.1` that any local process can access. The session is recorded as `headed: true` (since the authenticated browser is still running).

**Security note:** The login browser's `--remote-debugging-port` remains open on localhost for as long as the session is alive. This gives any local process full browser control — the same caveat agent-browser's own docs give about `--remote-debugging-port`. Call `agent_browser_close` when done with a session that went through login handoff, rather than leaving it open indefinitely. `agent_browser_close` will terminate the tracked login Chrome process and clean up its debugging port.

Agents should call `agent_browser_close` for the session as soon as the current task no longer needs it (no further browser-driven steps planned) — don't wait for the user to ask. Only leave it open when the task explicitly spans multiple steps or turns that will keep reusing the same session.

Run `agent_browser_doctor` to see which sessions still have live login browsers open. It reports any that are still running (session name, process ID, debugging port, and last known URL) with a reminder to call `agent_browser_close`. Stale tracking entries for processes no longer running are cleaned up silently with no user notification.

`agent_browser_login_handoff` also surfaces this automatically: its success message names any *other* sessions that still have a live login browser open (session name and process ID), so you don't have to run `agent_browser_doctor` separately just to notice one was left open.

Re-running `agent_browser_login_handoff` for the same session name will terminate any previous live login browser for that session before spawning a new one.

On a successful login, the tool does not force the agent to stop and wait for a new user turn — the session is immediately usable, so continue the original task right away (after a fresh `agent_browser_snapshot`). Only the failure/abort/no-UI paths end the turn, since those genuinely need a human or operator decision before anything else can happen.

## Common examples

Read a public page:

```json
{"url":"https://example.com","outputPath":"outputs/browser/example.md"}
```

Open, snapshot, click:

```json
{"url":"https://example.com","session":"research-example","allowedDomains":["example.com"]}
```

Then call `agent_browser_snapshot`, inspect refs, and call `agent_browser_click` with the chosen `@ref`.

Maintain login state automatically:

```json
{"url":"https://example.com","session":"work-example","restore":true}
```

List saved states:

```json
{"operation":"list"}
```

Clear a specific saved session state:

```json
{"operation":"clear","sessionName":"work-example"}
```
