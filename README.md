# novelbook

iPhone で読む、青空文庫形式の縦書き小説ビューワ（PWA）。
Mac が小説フォルダ（iCloud Drive など）を配信し、iPhone は Tailscale 経由でそれを読む。

## しくみ

- `server/server.ts`: 小説フォルダを配信する Node のサーバー（依存なし）。小説フォルダに書き込むのは、Gemini で作ったアイコンを置くときだけ。`127.0.0.1:8787` で待ち受ける
- `public/`: PWA 本体（ビルドなし）
  - `aozora.js`: 青空文庫記法の解析
  - `reader.js`: 縦書きのページ表示と読書位置の保存・復元
  - `sw.js`: オフライン用のキャッシュ（つながるときは常に最新を取る）

フォルダに `icon.png`（`icon.jpg` / `icon.webp` なども可）を置くと、そのフォルダのアイコンになる。アプリでフォルダのアイコンをタップすると、プリセットのアイコンからも選べる（選択は `NOVELBOOK_DATA_DIR`（既定は `~/Library/Application Support/novelbook`）の `icons.json` に保存する）。フォルダに置いた画像はプリセットより優先されるが、アイコンを選ぶシートのチェックボックスでプリセットを優先させることもできる。アイコンを選ぶシートの「Gemini で作る」では、フォルダ名（と任意の追加の指示）から Gemini にアイコンを作ってもらい、フォルダの `icon.png` にする。Mac 側で作り、できあがるまでは「仮」のアイコンを置いておく（前の画像はフォルダに `icon~1.png`、`icon~2.png`…と番号が大きいほど新しくなるように残し、作れなかったときは元に戻す）。続きを読むや各一覧では、作品の入っているシリーズ（小説フォルダ直下のフォルダ）のアイコンを出す。

挿絵は、テキストファイルからの相対パスで書く（例: `［＃挿絵（fig1.jpg）入る］` なら同じフォルダの `fig1.jpg`）。
大きな画像は Mac 側で長辺 2000px に縮小して返し、`NOVELBOOK_CACHE_DIR`（既定は `~/Library/Caches/novelbook`）にキャッシュする。

## セットアップ

### Mac

```sh
cp .env.example .env                # 配信するフォルダ（NOVELBOOK_ROOT）などを書き換える
scripts/install-agent.sh            # launchd に登録（ログイン時に自動起動）
tailscale serve --bg 8787           # Tailscale 内に HTTPS で公開
```

- 設定はリポジトリ直下の `.env`（git 管理外）に書く。項目は `.env.example` を参照。環境変数で渡せばそちらが優先される
- 配信するフォルダは `.env` の `NOVELBOOK_ROOT`。`scripts/install-agent.sh "/path/to/dir"` のように引数でも指定できる
- 初回は macOS が node の iCloud Drive へのアクセス許可を求める。許可しないとフォルダ一覧が読めない
- nodenv があれば node はシム経由で起動し、バージョンは `.node-version` で決まる。node を入れ替えたら再起動する（下の「サーバーの再起動」）
- iCloud の「Mac ストレージを最適化」で本体が消えているファイルは、開くときにダウンロードを待つ。小説フォルダは Finder で「ダウンロードを保持」にしておくと速い
- ログ: `~/Library/Logs/novelbook.log`。解除: `scripts/install-agent.sh --uninstall`
- Gemini でのアイコン作りは Antigravity の CLI（`~/.local/bin/agy`、`NOVELBOOK_AGY` で変更可）を `gemini-3.8-flash-medium`（`NOVELBOOK_AGY_MODEL` で変更可）で呼ぶので、Mac で `agy` にログインしておく。1 枚に 2〜3 分かかる
- `tailscale` コマンドがなければ `/Applications/Tailscale.app/Contents/MacOS/Tailscale` を使う

### サーバーの再起動

`server/` を変えたときや、nodenv で node を入れ替えたときは、常駐しているサーバーを再起動する。

```sh
launchctl kickstart -k gui/$(id -u)/local.novelbook
```

- サーバーは起動したときの node で動き続ける。再起動しないまま古い版の node を消すと、iCloud Drive が読めなくなる（`EPERM: operation not permitted, scandir ...`）
- 新しい版の node で初めて起動すると、macOS が iCloud Drive へのアクセス許可をもう一度求めることがある

### iPhone

1. Tailscale アプリを入れて、Mac と同じアカウントでログインする
2. Safari で `tailscale serve` が表示した `https://<Mac の名前>.<tailnet>.ts.net/` を開く
3. 共有 → 「ホーム画面に追加」

## 操作

- 画面の左側をタップ／右へスワイプで次のページ、右側をタップ／左へスワイプで前のページ
- 中央をタップでメニュー（フォルダへ戻る・ページ移動・目次・再読み込み・表示設定。メニューの「再読み込み」やファイラーの更新ボタンは、長押しでページ自体をブラウザ的に再読み込み）
- スワイプでめくるとページが指に追従する。挿絵はダブルタップで全画面表示になり、ピンチで拡大縮小できる
- PC のブラウザでも読める。広い画面では一覧を中央の列に、本文を見開きくらいの幅に収める。マウスのクリック・ホイール・トラックパッドの横スワイプや、キー（← ↓ PageDown Space で次、→ ↑ PageUp Shift+Space で前、Home / End で最初と最後、Esc でメニューやシートを閉じる）でめくれる。挿絵はホイールで拡大縮小できる
- 1 話 1 ファイルの前提で、目次は同じフォルダのテキストファイルをファイル名順に並べたもの。最後のページには次の話へのリンクを出す
- ファイラーには既読量・後で読む（栞）・お気に入り（♡）を表示する。トップには最近開いた 5 件（「もっと表示」で最大 100 件の履歴）と、後で読む・お気に入りの一覧（印を付けた日時が新しい順）、最近の更新（フォルダを横断して更新日時が新しい順に 100 件）への入口を出す
- メニューの「検索」で作品の中を、ファイラーの虫眼鏡で小説フォルダ全体を検索できる。結果を押すとそのページへ移り、見つかった言葉に印を付ける
- 前回読んだときから原稿が変わっていたら、変わった段落に色を付け、下のボタンで変更箇所へ順に移れる（基準の本文は行ごとの指紋だけを iPhone に保存して比べる。印は × で消すまで、何度開いても残る）
- フォルダの行には、中の話（サブフォルダも含む）のうち読み終えた数を「8/12話」のように出す
- 最後に読んだあとに更新された話は、ファイラーの各一覧（続きを読む・履歴・印の一覧・最近の更新・検索結果も）で既読量の左に小さな点を付ける。フォルダの行も、中の話（サブフォルダも含む）のどれかがそうなら点を付ける（まだ読んでいない話は数えない）
- 読書位置はページをめくるたびに保存される。原稿を書き換えて行がずれても、保存しておいた位置の文字列で探し直す
- アプリに戻ったとき、開いているファイルが更新されていれば自動で読み直す

## 開発

```sh
npm start   # サーバーを起動（設定は .env。localhost と *.ts.net 以外のホスト名で使うなら NOVELBOOK_ALLOWED_HOSTS にカンマ区切りで追加）
npm test    # 青空文庫記法の解析のテスト
swift scripts/make-icons.swift public/icons /path/to/icon.png   # アイコンの再生成
swift scripts/make-placeholder-icon.swift server/placeholder-icon.png   # 「仮」のアイコンの再生成
```

favicon（`public/icons/favicon-32.png` / `favicon-64.png`）は元画像を、タブで小さく見えないよう黒いシルエットの外接矩形＋6% の余白で正方形に切り抜いて縮小したもの。
