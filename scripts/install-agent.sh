#!/bin/zsh
# サーバーを launchd に登録して常駐させる（ログイン時に自動起動し、落ちたら再起動する）。
#   scripts/install-agent.sh                 # .env の UNICOBOOK_ROOT を配信（.env.example を参照）
#   scripts/install-agent.sh "/path/to/dir"  # 配信するフォルダを指定（.env より優先）
#   scripts/install-agent.sh --uninstall     # 登録を解除
set -euo pipefail

LABEL=local.unicobook
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/unicobook.log"
REPO="${0:A:h:h}"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  [[ -f "$PLIST" ]] && mv "$PLIST" "$HOME/.Trash/"
  echo "解除しました"
  exit 0
fi

ROOT_ARG="${1:-}"
# launchd は PATH やシェルの設定を読まないので絶対パスで指定する。nodenv があればシムを使い、
# 起動のたびに .node-version からバージョンを決めさせる（実体のパスだと古い版を消したときに起動できなくなる）
if command -v nodenv >/dev/null; then
  NODE="$(nodenv root)/shims/node"
else
  NODE="$(command -v node)"
fi

# 引数がなければ、サーバーと同じく .env から読む（plist には書かないので、.env を変えて再起動すれば反映される）
if [[ -n "$ROOT_ARG" ]]; then
  ROOT="${ROOT_ARG:A}"
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

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  print -r -- "$s"
}

mkdir -p "${PLIST:h}"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$REPO/server/server.ts")</string>
  </array>
$(if [[ -n "$ROOT_ARG" ]]; then cat <<ENV
  <key>EnvironmentVariables</key>
  <dict>
    <key>UNICOBOOK_ROOT</key><string>$(xml_escape "$ROOT")</string>
  </dict>
ENV
fi)
  <key>WorkingDirectory</key><string>$(xml_escape "$REPO")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout は非同期なので、前の登録が消えきる前に bootstrap すると失敗する
for _ in {1..50}; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "登録しました: $PLIST"
echo "node: $NODE"
echo "配信フォルダ: $ROOT"
echo "ログ: $LOG"
