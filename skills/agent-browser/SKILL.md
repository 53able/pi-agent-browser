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
