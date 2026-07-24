# pi-agent-browser

Pi extension wrapping [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser) for browser automation, rendered-page interaction, screenshots, saved browser state, and agent-readable context extraction.

This package exposes `agent-browser` CLI capabilities as typed Pi tools, so Pi can use browser sessions without hand-writing shell commands.

## Requirements

- Pi / Feynman runtime with package support
- [`agent-browser`](https://github.com/vercel-labs/agent-browser) installed and available on `PATH`
- Chrome for Testing installed through `agent-browser install`

Quick check:

```bash
agent-browser doctor
```

If `agent-browser` is not on `PATH`, set:

```bash
export AGENT_BROWSER_BIN=/absolute/path/to/agent-browser
```

## Installation

From GitHub:

```bash
pi install https://github.com/53able/pi-agent-browser
```

From npm after publish:

```bash
pi install npm:@53able/pi-agent-browser
```

From a local checkout:

```bash
git clone https://github.com/53able/pi-agent-browser.git
pi install ./pi-agent-browser
```

Or add the package source to Pi settings manually:

```json
{
  "packages": ["npm:@53able/pi-agent-browser"]
}
```

## Tools

The extension registers these Pi tools:

- `agent_browser_open` — open a URL or launch `about:blank`
- `agent_browser_read` — extract agent-readable text or JSON from a URL or active rendered tab
- `agent_browser_snapshot` — get accessibility tree refs for interaction
- `agent_browser_click` — click by `@ref` or CSS selector
- `agent_browser_fill` — fill an input by `@ref` or CSS selector
- `agent_browser_screenshot` — capture screenshots to disk
- `agent_browser_eval` — evaluate JavaScript in the active tab
- `agent_browser_state` — save, load, list, show, rename, clear, or clean saved state
- `agent_browser_close` — close a browser session
- `agent_browser_doctor` — run `agent-browser doctor`

## Basic usage

Ask Pi naturally:

```text
https://example.com を browser 経由で読んで、outputs/browser/example.md に保存して
```

Equivalent tool arguments for `agent_browser_read`:

```json
{
  "url": "https://example.com",
  "outputPath": "outputs/browser/example.md",
  "allowedDomains": ["example.com"]
}
```

## Browser interaction workflow

1. Open or navigate:

```json
{
  "url": "https://example.com",
  "session": "research-example",
  "allowedDomains": ["example.com"]
}
```

2. Call `agent_browser_snapshot` to get fresh `@ref` values.
3. Use `agent_browser_click` or `agent_browser_fill` with those refs.
4. Use `agent_browser_read` for text extraction or `agent_browser_screenshot` for visual evidence.
5. Close the session with `agent_browser_close` when finished.

## Login/session state

To keep login state automatically, use a stable `session` and `restore: true` on `agent_browser_open`:

```json
{
  "url": "https://example.com",
  "session": "work-example",
  "restore": true,
  "headed": true
}
```

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

Clear all saved states only when explicitly intended:

```json
{
  "operation": "clear",
  "all": true
}
```

## Safety notes

- Prefer `allowedDomains` for task-scoped browsing.
- Use `outputPath` for durable source artifacts that support reports.
- Take a fresh snapshot after navigation, form submission, modal dismissal, or failed clicks.
- Prefer `agent_browser_read` for textual evidence and `agent_browser_screenshot` for visual evidence.
- Use `agent_browser_eval` only when `read`/`snapshot` cannot expose the required state.

## Development

Dry-run the npm package contents:

```bash
npm run pack:dry
```

Local Pi test example:

```bash
PI_OFFLINE=1 pi --no-builtin-tools --tools agent_browser_doctor -p "Use agent_browser_doctor and report output"
```

## License

MIT

## Publishing

This repository is intended to publish through npm Trusted Publishing from GitHub Actions, not through long-lived npm tokens.

### npm Trusted Publisher setup

In npm, configure a trusted publisher for the package:

- Package: `@53able/pi-agent-browser`
- Publisher type: GitHub Actions
- GitHub owner: `53able`
- Repository: `pi-agent-browser`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Then publish a release by pushing a semver tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow uses GitHub OIDC with `id-token: write`, so no `NPM_TOKEN` secret is required.
