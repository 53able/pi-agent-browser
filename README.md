# pi-agent-browser

Typed browser automation tools for Pi, powered by [`agent-browser`](https://github.com/vercel-labs/agent-browser).

Use this package when Pi needs to operate real web pages, extract rendered context, keep login sessions, or capture visual evidence without falling back to ad-hoc shell commands.

## What you get

- **Rendered-page context extraction** — read text from public pages or the active authenticated browser tab.
- **Reliable interaction handles** — use accessibility snapshots with stable `@ref` targets for clicks and form fills.
- **Evidence capture** — save screenshots and extracted text to predictable artifact paths.
- **Session persistence** — reuse login state with named `agent-browser` sessions and restore support.
- **Safer browsing controls** — constrain work with `allowedDomains`, `maxOutput`, and explicit state management.
- **Typed Pi tools** — each browser action has its own schema instead of one free-form command string.

## Requirements

- Pi / Feynman runtime with package support
- [`agent-browser`](https://github.com/vercel-labs/agent-browser) installed and available on `PATH`
- Chrome for Testing installed through `agent-browser install`

Check your local setup:

```bash
agent-browser doctor
```

If `agent-browser` is installed outside `PATH`, set:

```bash
export AGENT_BROWSER_BIN=/absolute/path/to/agent-browser
```

## Installation

Install from npm:

```bash
pi install npm:@53able/pi-agent-browser
```

Install from GitHub:

```bash
pi install https://github.com/53able/pi-agent-browser
```

Install from a local checkout:

```bash
git clone https://github.com/53able/pi-agent-browser.git
pi install ./pi-agent-browser
```

## Registered tools

- `agent_browser_open` — open a URL or launch `about:blank`
- `agent_browser_read` — extract text or JSON from a URL or active rendered tab
- `agent_browser_snapshot` — get accessibility tree refs for interaction
- `agent_browser_click` — click by `@ref` or CSS selector
- `agent_browser_fill` — fill an input by `@ref` or CSS selector
- `agent_browser_screenshot` — capture screenshots to disk
- `agent_browser_eval` — evaluate JavaScript in the active tab
- `agent_browser_state` — save, load, list, show, rename, clear, or clean saved state
- `agent_browser_close` — close a browser session
- `agent_browser_doctor` — run `agent-browser doctor`

## Common workflows

### Read a page and save the extracted source

Ask Pi:

```text
https://example.com をブラウザ経由で読み、outputs/browser/example.md に保存して
```

Equivalent `agent_browser_read` arguments:

```json
{
  "url": "https://example.com",
  "outputPath": "outputs/browser/example.md",
  "allowedDomains": ["example.com"]
}
```

### Interact with a rendered page

1. Open the page.

```json
{
  "url": "https://example.com",
  "session": "research-example",
  "allowedDomains": ["example.com"]
}
```

2. Call `agent_browser_snapshot` to get fresh `@ref` values.
3. Use `agent_browser_click` or `agent_browser_fill` with those refs.
4. Call `agent_browser_read` for text or `agent_browser_screenshot` for visual evidence.
5. Close the session with `agent_browser_close` when finished.

### Keep login state across runs

Use a stable session name and `restore: true`:

```json
{
  "url": "https://example.com",
  "session": "work-example",
  "restore": true,
  "headed": true
}
```

After logging in once, future opens with the same `session` and `restore` can reuse saved browser state.

### Inspect or clear saved state

List saved states:

```json
{
  "operation": "list"
}
```

Clear one saved session state:

```json
{
  "operation": "clear",
  "sessionName": "work-example"
}
```

Clear all saved states only when intentionally resetting everything:

```json
{
  "operation": "clear",
  "all": true
}
```

## Safety guidance

- Pass `allowedDomains` whenever the browsing scope is known.
- Use `outputPath` when extracted content supports a report, audit, or later verification.
- Take a fresh snapshot after navigation, form submission, modal dismissal, or a failed click.
- Prefer `agent_browser_read` for textual evidence and `agent_browser_screenshot` for visual evidence.
- Use `agent_browser_eval` only when `read` or `snapshot` cannot expose the required state.
- Review saved browser state before clearing broadly.

## Troubleshooting

Run:

```bash
agent-browser doctor
```

Or ask Pi to run `agent_browser_doctor`.

Common fixes:

```bash
npm install -g agent-browser
agent-browser install
```

## Project history

For the extraction story, package-name decision, npm Trusted Publisher setup, and semantic-release workflow, see [`docs/project-history.md`](docs/project-history.md).

## Release automation

Releases are automated with semantic-release. Maintainers merge Conventional Commits into `main`; GitHub Actions runs `npx semantic-release@25`, determines the next version, publishes to npm through Trusted Publishing, creates the Git tag, and writes the GitHub Release.

Commit message examples:

- `fix: handle empty snapshot output` → patch release
- `feat: add browser state export tool` → minor release
- `feat!: rename tool arguments` or `BREAKING CHANGE:` → major release

The npm Trusted Publisher should continue to point at `.github/workflows/publish.yml`. No long-lived `NPM_TOKEN` is required.

## License

MIT
