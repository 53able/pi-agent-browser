# Why this package exists

This note explains the decisions behind `@53able/pi-agent-browser`: why it was created, why it uses a scoped npm name, and how releases are automated.

It is mainly for maintainers and contributors. If you only want to install and use the package, start with the [README](../README.md).

## 日本語での要約

このパッケージは、Pi から `agent-browser` を使うときの操作を、文字列コマンドではなく型付きツールとして扱えるようにするために作りました。

最初はローカルの Pi 拡張として実装し、動作確認後に OSS パッケージとして切り出しました。既に `pi-agent-browser` という npm パッケージが存在していたため、名前の衝突を避けて `@53able/pi-agent-browser` として公開しています。

リリースは GitHub Actions と npm Trusted Publishing で行います。現在は semantic-release を使っており、`main` に入った Conventional Commits をもとに、必要なときだけ npm publish と GitHub Release が作られます。長期利用する npm token は使いません。

## The problem we wanted to solve

Pi can already run shell commands, so it can call [`agent-browser`](https://github.com/vercel-labs/agent-browser) directly. That works for quick experiments, but it has a weak interface for repeatable agent work:

- every browser action is a shell string
- outputs are not consistently shaped
- saved screenshots and extracted text are easy to lose
- login/session state needs manual handling
- safety options such as `allowedDomains` are easy to forget

The extension began as a local wrapper around `agent-browser` to solve those issues. The goal was not to replace `agent-browser`; it was to make its browser capabilities feel native inside Pi.

## What was extracted

The local extension exposed browser actions as typed Pi tools:

- `agent_browser_open`
- `agent_browser_read`
- `agent_browser_snapshot`
- `agent_browser_click`
- `agent_browser_fill`
- `agent_browser_screenshot`
- `agent_browser_eval`
- `agent_browser_state`
- `agent_browser_close`
- `agent_browser_doctor`

This made each action explicit. Pi can see the expected arguments, return artifact paths, preserve session names, and guide the model toward safer browsing patterns.

Once the local version worked, it was moved into a standalone repository so other Pi users could install it.

Repository:

```text
https://github.com/53able/pi-agent-browser
```

## Why the package is scoped

The unscoped npm name `pi-agent-browser` was already taken:

- npm: https://www.npmjs.com/package/pi-agent-browser
- repository metadata: `github.com/coctostan/pi-agent-browser`

That package has a similar goal, but a different interface. It exposes one generic `browser` tool that accepts an `agent-browser` command string.

This package uses multiple typed tools instead. The tradeoff is intentional:

| Package | Interface | Best fit |
| --- | --- | --- |
| `pi-agent-browser` | One free-form `browser` command string | Flexible CLI-style control |
| `@53able/pi-agent-browser` | Separate typed `agent_browser_*` tools | Structured Pi workflows, saved artifacts, session/state handling |

To avoid confusion and make ownership clear, this package is published as:

```text
@53able/pi-agent-browser
```

## npm and Trusted Publishing setup

The first npm release created the package:

```text
@53able/pi-agent-browser@0.1.0
```

After the package existed on npm, Trusted Publisher was configured for GitHub Actions:

- npm package: `@53able/pi-agent-browser`
- GitHub owner: `53able`
- GitHub repository: `pi-agent-browser`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

This lets GitHub Actions publish through npm OIDC. The repository does not need a long-lived `NPM_TOKEN` secret for publishing.

## README cleanup

The first npm README mixed user-facing instructions with maintainer details such as publishing setup. That made the package page less useful for people deciding whether to install it.

The README was revised to lead with user value:

- rendered-page context extraction
- stable `@ref` handles for interaction
- screenshot and artifact capture
- persistent browser sessions
- safer browsing controls
- typed Pi tools instead of raw command strings

That user-focused README was released as `0.1.1`.

## Current release workflow

Releases now run through [`semantic-release`](https://github.com/semantic-release/semantic-release).

The current flow is:

1. A maintainer merges commits into `main`.
2. GitHub Actions runs `.github/workflows/publish.yml`.
3. The workflow runs `npx semantic-release@25`.
4. semantic-release reads commits since the latest release tag.
5. If a release is needed, semantic-release chooses the next version, publishes to npm, creates the Git tag, and creates a GitHub Release.
6. npm publish uses Trusted Publishing / OIDC.

The workflow deliberately avoids `actions/setup-node`'s `registry-url` option. That option can create an `.npmrc` that interferes with semantic-release's npm authentication flow.

## Commit messages drive releases

Use Conventional Commits on `main`.

```text
fix: handle empty snapshot output
```

Creates a patch release.

```text
feat: add browser state export tool
```

Creates a minor release.

```text
feat!: rename browser state arguments
```

Creates a major release.

A commit such as `docs: ...`, `ci: ...`, or `chore: ...` can still run the workflow, but it should not publish a new npm version.

## Release workflow check

After the semantic-release migration, the workflow ran successfully. semantic-release reported that npm OIDC authentication worked and that no release was needed for the `ci:` commit:

```text
OIDC token exchange with the npm registry succeeded
Found git tag v0.1.1 associated with version 0.1.1
There are no relevant changes, so no new version is released.
```

That means the authentication and release plumbing are in place. The next `fix:`, `feat:`, or breaking-change commit on `main` should produce the corresponding npm release.

## User install command

```bash
pi install npm:@53able/pi-agent-browser
```

日本語で説明するなら、このパッケージは「Pi にブラウザ操作、ページ抽出、スクリーンショット保存、ログイン状態の再利用を追加する拡張」です。
