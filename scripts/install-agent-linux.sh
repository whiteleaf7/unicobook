#!/usr/bin/env bash
# サーバーを systemd のユーザーサービスに登録して常駐させる（ログイン時に自動起動し、落ちたら再起動する）。Linux 用で、macOS は install-agent.sh を使う。
#   scripts/install-agent-linux.sh                 # .env の UNICOBOOK_ROOT を配信（.env.example を参照）
#   scripts/install-agent-linux.sh "/path/to/dir"  # 配信するフォルダを指定（.env より優先）
#   scripts/install-agent-linux.sh --uninstall     # 登録を解除
# ログは journal に出す（journalctl --user -u unicobook で読む）
set -euo pipefail

NAME=unicobook
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$NAME.service"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemd のユーザーセッションにつながりません（systemctl --user が使えるログインセッションで実行してください）" >&2
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "解除しました"
  exit 0
fi

ROOT_ARG="${1:-}"
# systemd はシェルの設定を読まないので絶対パスで指定する。nodenv があればシムを使い、
# 起動のたびに .node-version からバージョンを決めさせる（実体のパスだと古い版を消したときに起動できなくなる）
if command -v nodenv >/dev/null; then
  NODE="$(nodenv root)/shims/node"
else
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" ]]; then
  echo "node が見つかりません。Node.js 24 以降を入れてください" >&2
  exit 1
fi

# 引数がなければ、サーバーと同じく .env から読む（unit には書かないので、.env を変えて再起動すれば反映される）
if [[ -n "$ROOT_ARG" ]]; then
  ROOT="$(realpath -m -- "$ROOT_ARG")"
else
  ROOT="$(cd "$REPO" && "$NODE" --env-file-if-exists=.env -p 'process.env.UNICOBOOK_ROOT?.trim() ?? ""')"
  [[ "$ROOT" == "~" || "$ROOT" == "~/"* ]] && ROOT="$HOME${ROOT#\~}"
  if [[ -z "$ROOT" ]]; then
    echo "配信するフォルダを引数か .env の UNICOBOOK_ROOT で指定してください（.env.example を参照）" >&2
    exit 1
  fi
fi

if [[ ! -d "$ROOT" ]]; then
  echo "フォルダが見つかりません: $ROOT" >&2
  exit 1
fi

# サーバーは pnpm build で作った dist/ を配信する。開発モード（UNICOBOOK_DEV=1）なら public/ をそのまま配信するので作らない
DEV="${UNICOBOOK_DEV:-$(cd "$REPO" && "$NODE" --env-file-if-exists=.env -p 'process.env.UNICOBOOK_DEV?.trim() ?? ""')}"
if [[ "$DEV" != "1" ]]; then
  if ! command -v pnpm >/dev/null; then
    cat >&2 <<'MSG'
pnpm が見つかりません。次のどちらかで、ホームディレクトリの下に入れてから実行し直してください。
  corepack enable --install-directory ~/.local/bin pnpm     # Node.js 24 に付いている corepack を使う
  curl -fsSL https://get.pnpm.io/install.sh | sh -          # pnpm の公式のインストーラー（~/.local/share/pnpm に入る）
MSG
    exit 1
  fi
  (cd "$REPO" && pnpm install --frozen-lockfile && pnpm build)
fi

# 大きな画像の縮小には ffmpeg（ffmpeg と ffprobe）を使う。無くても動くが、画像は縮小せずに返す
for cmd in ffmpeg ffprobe; do
  command -v "$cmd" >/dev/null || echo "警告: $cmd が見つかりません。大きな画像を縮小せずに返します" >&2
done

# unit ファイルの値として書けるようにする。% は systemd の指定子なので %% にする
unit_quote() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//%/%%}"
  printf '"%s"' "$s"
}
# ExecStart では $ も変数展開されるので $$ にする
exec_quote() {
  unit_quote "${1//\$/\$\$}"
}
unit_path() {
  printf '%s' "${1//%/%%}"
}

mkdir -p "$(dirname "$UNIT")"
{
  cat <<EOF
[Unit]
Description=unicobook（青空文庫形式の小説ビューワ）
After=network.target

[Service]
Type=simple
ExecStart=$(exec_quote "$NODE") $(exec_quote "$REPO/server/server.ts")
WorkingDirectory=$(unit_path "$REPO")
EOF
  if [[ -n "$ROOT_ARG" ]]; then
    echo "Environment=$(unit_quote "UNICOBOOK_ROOT=$ROOT")"
  fi
  cat <<EOF
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
} > "$UNIT"

WAS_ACTIVE=0
systemctl --user is-active --quiet "$NAME" && WAS_ACTIVE=1
systemctl --user daemon-reload
systemctl --user enable --now "$NAME"
# すでに動いていたら、新しい設定で起動し直す
if [[ "$WAS_ACTIVE" == 1 ]]; then
  systemctl --user restart "$NAME"
fi
echo "登録しました: $UNIT"
echo "node: $NODE"
echo "配信フォルダ: $ROOT"
echo "ログ: journalctl --user -u $NAME"
