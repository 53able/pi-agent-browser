# pi-agent-browser

`pi-agent-browser` は、Pi から実ブラウザを操作するための typed tools を追加する拡張です。内部では [`agent-browser`](https://github.com/vercel-labs/agent-browser) を使います。

Pi が Web ページを開き、rendered context を抽出し、ログイン状態を保ち、スクリーンショットを証跡として残す必要があるときに使います。raw shell command を毎回組み立てる代わりに、Pi の tool として呼び出せます。

## できること

- **Rendered page の context extraction** — 公開ページやログイン済み browser tab から text を読む
- **安定した操作対象** — accessibility snapshot の `@ref` を使って click / fill する
- **証跡保存** — screenshot や抽出 text を artifact path に保存する
- **Session persistence** — 名前付き `agent-browser` session と restore でログイン状態を再利用する
- **安全な browsing control** — `allowedDomains`、`maxOutput`、state management で操作範囲を絞る
- **Typed Pi tools** — 1つの自由形式 command string ではなく、操作ごとの schema を使う

## Requirements

- package support 付きの Pi / Feynman runtime
- [`agent-browser`](https://github.com/vercel-labs/agent-browser) が `PATH` 上にあること
- `agent-browser install` で Chrome for Testing が入っていること

確認:

```bash
agent-browser doctor
```

`agent-browser` が `PATH` 外にある場合:

```bash
export AGENT_BROWSER_BIN=/absolute/path/to/agent-browser
```

## Installation

npm から install:

```bash
pi install npm:@53able/pi-agent-browser
```

GitHub から install:

```bash
pi install https://github.com/53able/pi-agent-browser
```

local checkout から install:

```bash
git clone https://github.com/53able/pi-agent-browser.git
pi install ./pi-agent-browser
```

## Registered tools

- `agent_browser_open` — URL を開く、または `about:blank` を起動する
- `agent_browser_read` — URL または active rendered tab から text / JSON を抽出する
- `agent_browser_snapshot` — 操作用の accessibility tree refs を取得する
- `agent_browser_click` — `@ref` または CSS selector で click する
- `agent_browser_fill` — `@ref` または CSS selector で input を埋める
- `agent_browser_screenshot` — screenshot を disk に保存する
- `agent_browser_eval` — active tab で JavaScript を評価する
- `agent_browser_state` — saved state を save / load / list / show / rename / clear / clean する
- `agent_browser_close` — browser session を閉じる
- `agent_browser_doctor` — `agent-browser doctor` を実行する

## よく使う流れ

### ページを読んで抽出結果を保存する

Pi にはそのまま依頼できます。

```text
https://example.com をブラウザ経由で読み、outputs/browser/example.md に保存して
```

`agent_browser_read` の引数で表すと次の形です。

```json
{
  "url": "https://example.com",
  "outputPath": "outputs/browser/example.md",
  "allowedDomains": ["example.com"]
}
```

### rendered page を操作する

1. ページを開きます。

```json
{
  "url": "https://example.com",
  "session": "research-example",
  "allowedDomains": ["example.com"]
}
```

2. `agent_browser_snapshot` で新しい `@ref` を取得します。
3. `agent_browser_click` または `agent_browser_fill` にその ref を渡します。
4. text が必要なら `agent_browser_read`、見た目の証跡が必要なら `agent_browser_screenshot` を使います。
5. 終わったら `agent_browser_close` で session を閉じます。

### ログイン状態を再利用する

安定した session name と `restore: true` を使います。

```json
{
  "url": "https://example.com",
  "session": "work-example",
  "restore": true,
  "headed": true
}
```

一度ログインしたあと、同じ `session` と `restore` で開くと saved browser state を再利用できます。

### saved state を確認・削除する

一覧:

```json
{
  "operation": "list"
}
```

特定 session の state を削除:

```json
{
  "operation": "clear",
  "sessionName": "work-example"
}
```

すべて削除する場合だけ、明示的に `all` を使います。

```json
{
  "operation": "clear",
  "all": true
}
```

## Safety guidance

- browsing scope が分かっている場合は `allowedDomains` を渡してください。
- report、audit、後日の verification に使う抽出結果は `outputPath` に保存してください。
- navigation、form submit、modal dismissal、failed click のあとには fresh snapshot を取り直してください。
- text evidence には `agent_browser_read`、visual evidence には `agent_browser_screenshot` を優先してください。
- `agent_browser_eval` は、`read` や `snapshot` では必要な state が取れない場合にだけ使ってください。
- saved browser state を広く消す前に、対象を確認してください。

## Troubleshooting

```bash
agent-browser doctor
```

または Pi に `agent_browser_doctor` を実行させてください。

よくある修正:

```bash
npm install -g agent-browser
agent-browser install
```

## Project history

package 名の判断、npm Trusted Publishing、semantic-release workflow については、言語別の project history を参照してください。

- [English](project-history.en.md)
- [日本語](project-history.ja.md)

## License

MIT
