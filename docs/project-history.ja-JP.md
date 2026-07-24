# このパッケージを作った理由

この文書は、`@53able/pi-agent-browser` を作った理由、scoped package 名を選んだ理由、リリース自動化の流れを記録したものです。

主な読者はメンテナとコントリビュータです。インストールして使いたいだけの場合は、まず [README](../README.md) を読んでください。

## 解決したかった問題

Pi は shell command を実行できるため、[`agent-browser`](https://github.com/vercel-labs/agent-browser) を直接呼び出せます。短い検証ならそれで十分です。ただし、繰り返し使うエージェントの作業としては、次の弱さがありました。

- ブラウザ操作がすべて文字列コマンドになる
- 出力の形がそろわない
- 保存したスクリーンショットや抽出テキストを見失いやすい
- ログイン状態や session state を手で扱う必要がある
- `allowedDomains` などの安全設定を忘れやすい

この拡張は、それらを解消するためのローカル wrapper として始まりました。`agent-browser` を置き換えることではなく、Pi の中で `agent-browser` の機能を自然に使えるようにすることが目的です。

## 切り出したもの

ローカル拡張では、ブラウザ操作を次の typed Pi tools として公開しました。

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

各操作を分けることで、Pi は引数の形を把握できます。artifact path を返したり、session 名を保ったり、安全なブラウザ操作へ誘導したりしやすくなります。

ローカル版が動いたあと、他の Pi ユーザーもインストールできるように standalone repository へ移しました。

Repository:

```text
https://github.com/53able/pi-agent-browser
```

## scoped package にした理由

unscoped な npm package 名 `pi-agent-browser` は、すでに使われていました。

- npm: https://www.npmjs.com/package/pi-agent-browser
- repository metadata: `github.com/coctostan/pi-agent-browser`

既存パッケージも `agent-browser` を Pi から使うという意味では近い目的を持っています。ただし interface が違います。既存パッケージは、`agent-browser` のコマンド文字列を受け取る単一の `browser` tool を公開しています。

このパッケージは、複数の typed tools を公開します。違いは次の通りです。

| Package | Interface | 向いている用途 |
| --- | --- | --- |
| `pi-agent-browser` | 1つの自由形式 `browser` command string | CLI に近い柔軟な操作 |
| `@53able/pi-agent-browser` | 複数の typed `agent_browser_*` tools | 構造化された Pi workflow、artifact 保存、session/state 管理 |

名前の衝突を避け、所有者を明確にするため、このパッケージは次の名前で公開しています。

```text
@53able/pi-agent-browser
```

## npm と Trusted Publishing

最初の npm release で package を作成しました。

```text
@53able/pi-agent-browser@0.1.0
```

package が npm 上に存在したあと、GitHub Actions 用の Trusted Publisher を設定しました。

- npm package: `@53able/pi-agent-browser`
- GitHub owner: `53able`
- GitHub repository: `pi-agent-browser`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

これにより、GitHub Actions は npm OIDC 経由で publish できます。publish 用の長期 `NPM_TOKEN` secret は不要です。

## README の整理

最初の npm README には、利用者向けの説明と、メンテナ向けの publish 設定が混ざっていました。パッケージページを見た人にとって、インストールする価値が分かりにくい状態でした。

README は、利用者のメリットが先に伝わるように整理しました。

- rendered page からの context extraction
- `@ref` による安定した操作対象
- screenshot と artifact の保存
- browser session の再利用
- browsing scope を絞る安全設定
- raw command string ではなく typed Pi tools として使えること

この利用者向け README は `0.1.1` として release しました。

## 現在のリリース workflow

現在の release は [`semantic-release`](https://github.com/semantic-release/semantic-release) で行います。

流れは次の通りです。

1. メンテナが `main` に commit を merge する。
2. GitHub Actions が `.github/workflows/publish.yml` を実行する。
3. workflow が `npx semantic-release@25` を実行する。
4. semantic-release が最新 release tag 以降の commit を読む。
5. release が必要なら、次の version を決め、npm publish、Git tag 作成、GitHub Release 作成を行う。
6. npm publish は Trusted Publishing / OIDC を使う。

workflow では、`actions/setup-node` の `registry-url` option をあえて使っていません。この option は `.npmrc` を生成し、semantic-release の npm authentication flow とぶつかることがあるためです。

## Commit message が release を決める

`main` に入れる commit は Conventional Commits に従います。

```text
fix: handle empty snapshot output
```

patch release になります。

```text
feat: add browser state export tool
```

minor release になります。

```text
feat!: rename browser state arguments
```

major release になります。

`docs: ...`、`ci: ...`、`chore: ...` のような commit でも workflow は動きます。ただし通常は npm の新しい version は publish されません。

## release workflow の確認

semantic-release へ移行したあと、workflow は成功しました。semantic-release は、npm OIDC authentication が成功し、`ci:` commit では release 不要だと報告しました。

```text
OIDC token exchange with the npm registry succeeded
Found git tag v0.1.1 associated with version 0.1.1
There are no relevant changes, so no new version is released.
```

これで認証と release の配線は確認できています。次に `fix:`、`feat:`、breaking change の commit が `main` に入ると、対応する npm release が作られる想定です。

## インストール方法

```bash
pi install npm:@53able/pi-agent-browser
```
