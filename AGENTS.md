# unicobook

青空文庫形式の小説を、iPhone で縦書きで読むためのビューワ（PWA）。Mac のサーバーが小説フォルダを配信し、iPhone は Tailscale を経由して読む。使い方と全体のしくみは `README.md` を参照。

## 構成と前提

- `server/`: サーバー。TypeScript を、Node.js 24 の型の除去でそのまま動かす（ビルドしない）。`tsconfig.json` は `erasableSyntaxOnly` なので、`enum`・`namespace`・コンストラクタ引数のプロパティなど、型を消すだけでは動かない構文は使わない。import には `.ts` の拡張子を付ける。
- `public/`: PWA の本体。素の JavaScript（ES modules）で書く。`public/aozora.js` はサーバーからも import している。
- `scripts/build.ts`: `pnpm build` で、`public/` を esbuild で `dist/` にまとめる（JavaScript は `app.js` から 1 ファイルに束ねて圧縮し、CSS と `sw.js` も圧縮する）。`dist/` は git 管理外。
- サーバーはふだん `dist/` を配信し、開発モード（`.env` の `UNICOBOOK_DEV=1`、または `pnpm dev`）では `public/` をビルドせずにそのまま配信する。
- `test/`: `node --test` で動かすテスト。
- macOS と Linux（Ubuntu）で動く。OS で変わる処理は `server/platform.ts`（OS の判定とパスの既定値）と `server/image-tool.ts`（macOS は sips、Linux は ffmpeg）に寄せ、OS は引数で差し替えられるようにする。常駐化は macOS が `scripts/install-agent.sh`（launchd）、Linux が `scripts/install-agent-linux.sh`（systemd のユーザーサービス）。
- 実行時の依存パッケージは入れず、Node.js の標準モジュールとブラウザの標準機能だけで書く。`devDependencies` はビルド・整形・リントの道具だけ。
- コメントや画面の文言は日本語で書く。

## 安全のために守ること

ログインのないアプリなので、次の守りを崩さないこと。

- サーバーは `127.0.0.1` だけで待ち受ける。外からは `tailscale serve` を経由する。
- すべてのリクエストは `server/guard.ts` の `rejectReason()` を通す（Host・Origin・Sec-Fetch-Site を見て、別のサイトからのリクエストを拒否する）。新しい API を足すときも、この確認を外さない。
- クライアントから来たパスは、必ず `server/files.ts` の `resolveInRoot()` で、小説フォルダの外に出ないことを確かめてから使う。
- 小説フォルダに書き込むのは、フォルダのアイコンを置くときだけ。ユーザーデータは `UNICOBOOK_DATA_DIR` に、作業ファイルは `UNICOBOOK_CACHE_DIR` に置く。
- 小説の本文や Gemini の返事などを画面に出すときは、`escapeHtml()` でエスケープするか `textContent` で入れる。そのまま `innerHTML` に入れない。

## Service Worker

- 画面を開くのに要るファイルを `public/` に足したときは、`public/sw.js` の `SHELL` にも足す。`app.js` が import するモジュールは `MODULES` に足す（ビルドした版では `app.js` にまとまるので、`MODULES` は空になる）。
- そのまま写すファイルやフォルダ（`index.html` から参照する画像など）を足したときは、`scripts/build.ts` の `COPIED` にも足す。
- `SHELL` のファイルを消したり名前を変えたりしたときは、`CACHE` の版を上げる（端末に残った古いキャッシュを消すため）。

## ルール

### サーバー更新時の再起動

`scripts/install-agent.sh` で launchd に登録している場合、`server/` 配下のコード（サーバー処理）を変更したら、常駐しているサービスに反映させるため、必ずサーバーを再起動すること。

```bash
launchctl kickstart -k gui/$(id -u)/local.unicobook
```

### テスト実行

コード変更後はテストを実行して破損がないことを確認すること。

```bash
pnpm test
```

npm は使わず、pnpm を使うこと。

### ビルドの確認

`public/` や `scripts/build.ts` を変更したら、`pnpm build` が通ることを確認すること。常駐しているサーバーが開発モードでない（`dist/` を配信している）場合は、ビルドし直さないと変更が画面に反映されない。

```bash
pnpm build
```

### 整形とリント

コード変更後は整形とリントもかけること。整形は Biome（整形だけに使う）、リントは oxlint ＋ oxlint-tsgolint（型情報を使うルールと型チェックを含む）。初めてのときは先に `pnpm install` で道具を入れる。

```bash
pnpm format
pnpm lint
```

### 変更時の都度コミット

何かしら変更した場合は都度コミットすること。
