# pi-agent-browser

[English](README.md) | 日本語

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
- `agent_browser_handoff` — 2FA・CAPTCHA・本人確認のために一時停止し、人間に操作を戻す
- `agent_browser_login_handoff` — インタラクティブなログイン（Google、OAuth など）のための無人 browser を起動する
- `agent_browser_commit` — 決済・削除・投稿・送信など、やり直しのきかない操作の確認ゲート
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

## 人間への handoff（引き渡し）

すべての操作を無人で任せるべきではありません。適切なタイミングで人間に操作を戻すためのツールが3つあります。

- **安全な境界線** — `agent_browser_handoff` は、AI自身では対応できない・すべきでない操作（2FA/OTPの入力、CAPTCHA、本人確認）の直前でエージェントを一時停止させます。スクリーンショットで状況を記録したあと、実際のUIダイアログでブロックし、人間が「対応完了」または「中止」を選ぶまで待ちます。`agent_browser_read` / `agent_browser_snapshot` も簡易なキーワード検知を行い、こうしたチェックポイントらしき内容を出力に警告として付加します（この警告自体は停止ではなく、`agent_browser_handoff` を呼ぶきっかけとして扱ってください）。
- **インタラクティブなログイン** — `agent_browser_login_handoff` は、Google や OAuth など多くのプロバイダで sign-in がブロックされる問題を解決します。これは、agent-browser が使われた時点でオートメーション検出が起きるため、ログイン中に拒否されるというもの。このツールは CDP が接続されていない無人 Chrome プロセスを起動し、人間が正常にログインできるようにしてから、ログイン成功後に `agent-browser` を接続します。Google や OAuth の sign-in フローが期待されるタスクでは、`agent_browser_open` ではなく必ずこちらを使ってください。
- **Commit前の停止** — `agent_browser_commit` は、決済・削除・投稿・送信といった「やり直しのきかない操作」専用の確認ゲートです。証跡を保存し、クリックの前に必ず人間の明示的な確認を求め、承認されない限りクリックは実行されません。対話的なUIが利用できない場合は、クリックせずにそのまま拒否します。こうした操作の最終確認クリックには `agent_browser_click` ではなく必ずこちらを使ってください。

3つのツールすべてが対話的なセッション（TUI、またはUI対応のRPC）を必要とします。無人・headless実行では、黙って進めるのではなく拒否します。

`agent_browser_open` と `agent_browser_login_handoff` は、各セッションが`headed: true`で起動されたかどうかも記録します。`agent_browser_handoff`が、headedで開かれていないセッションに対して呼ばれた場合、人間への警告に加えて、可視ウィンドウを開き直すための`agent_browser_open`の引数（セッション名、`headed: true`、`restore: true`、最後に開いていたURL）をそのまま提示します — どのコマンドを打ち直せばよいか推測する必要はありません。ログインや2FA、CAPTCHA、本人確認に差し掛かる可能性があるタスクでは、最初から`headed: true`で開くことを推奨します。一部の確認チャレンジは使い切り・期限付きのため、途中で開き直すとログインからやり直しになることがあります。

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

- [English](docs/project-history.en.md)
- [日本語](docs/project-history.ja-JP.md)

## License

MIT
