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

### 整形とリント

コード変更後は整形とリントもかけること。整形は Biome（整形だけに使う）、リントは oxlint ＋ oxlint-tsgolint（型情報を使うルールと型チェックを含む）。

```bash
pnpm format
pnpm lint
```

### 変更時の都度コミット

何かしら変更した場合は都度コミットすること。
