# Project history and release setup

This document records why this package exists, how the npm/GitHub setup was chosen, and how releases now work.

## Background

The project started as a local Pi extension that wraps [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser). The goal was to make browser automation feel native inside Pi instead of asking agents to compose raw shell commands.

The first implementation exposed typed tools such as `agent_browser_open`, `agent_browser_read`, `agent_browser_snapshot`, `agent_browser_click`, `agent_browser_fill`, `agent_browser_screenshot`, `agent_browser_eval`, `agent_browser_state`, `agent_browser_close`, and `agent_browser_doctor`.

The local extension was then extracted into an OSS package so other Pi users could install it.

## Package name decision

The unscoped npm package name `pi-agent-browser` was already taken by an existing package:

- npm: https://www.npmjs.com/package/pi-agent-browser
- repository metadata: `github.com/coctostan/pi-agent-browser`

That package and this package have a similar broad purpose: both wrap `agent-browser` for Pi. The implementation approach differs:

- Existing `pi-agent-browser`: exposes one generic `browser` tool that accepts an `agent-browser` command string.
- This package: exposes multiple typed `agent_browser_*` tools with structured schemas, saved artifacts, session/state controls, and safer defaults.

To avoid name collision and make ownership clear, this package is published as:

```text
@53able/pi-agent-browser
```

## Repository setup

The package was extracted to a standalone repository:

```text
https://github.com/53able/pi-agent-browser
```

Initial OSS files added:

- `index.ts` — Pi extension implementation
- `skills/agent-browser/SKILL.md` — companion skill guidance
- `package.json` — npm and Pi package metadata
- `README.md` — user-facing installation and usage guide
- `LICENSE` — MIT
- `CHANGELOG.md`
- `.github/workflows/publish.yml`
- `release.config.cjs`

## npm publish and Trusted Publishing

The package was first published to npm as:

```text
@53able/pi-agent-browser@0.1.0
```

After the package existed on npm, Trusted Publisher was configured for GitHub Actions:

- npm package: `@53able/pi-agent-browser`
- GitHub owner: `53able`
- GitHub repository: `pi-agent-browser`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

This lets GitHub Actions publish through npm OIDC without a long-lived `NPM_TOKEN`.

## README correction

The first npm README included maintainer-focused content such as development commands and Trusted Publisher setup. That was not ideal for package users. The README was rewritten to focus on user benefits and practical workflows:

- rendered-page context extraction
- reliable interaction handles with `@ref`
- screenshot and artifact capture
- session persistence
- safer browsing controls
- typed Pi tools

This user-focused README was released as `0.1.1`.

## Release automation

The project now uses [`semantic-release`](https://github.com/semantic-release/semantic-release) from GitHub Actions.

Current release behavior:

- pushes to `main` run `.github/workflows/publish.yml`
- the workflow runs `npx semantic-release@25`
- semantic-release reads Conventional Commit messages since the latest release tag
- if a release is needed, it determines the next version, publishes to npm, creates a Git tag, and creates a GitHub Release
- npm publish uses Trusted Publishing / OIDC
- no `NPM_TOKEN` secret is required

The workflow intentionally avoids `actions/setup-node` `registry-url` so semantic-release and npm OIDC authentication are not disrupted by an auto-generated `.npmrc`.

## Commit conventions

Use Conventional Commits on `main`:

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

A commit with only `docs:`, `ci:`, `chore:`, or other non-release types may run the workflow but should not publish a new npm version.

## Verification already performed

The release workflow was run after the semantic-release migration. It completed successfully and semantic-release reported:

```text
OIDC token exchange with the npm registry succeeded
Found git tag v0.1.1 associated with version 0.1.1
There are no relevant changes, so no new version is released.
```

This means the CI authentication path is working. The test commit was `ci: automate releases with semantic-release`, so no new package version was expected.

## Current install command

Users should install the package with:

```bash
pi install npm:@53able/pi-agent-browser
```
