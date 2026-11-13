# unicobook

## ルール

### サーバー更新時の再起動

`server/` 配下のコード（サーバー処理）を変更した場合は、常駐している launchd サービスに反映させるため、必ずサーバーを再起動すること。

```bash
launchctl kickstart -k gui/$(id -u)/local.unicobook
```

### テスト実行

コード変更後はテストを実行して破損がないことを確認すること。

```bash
pnpm test
```

npm は使わず、pnpm を使うこと。

### 変更時の都度コミット

何かしら変更した場合は都度コミットすること。
