// リポジトリ直下の .env を読み込む（なければ何もしない）。すでに設定されている環境変数が優先される。
// ほかのモジュールがトップレベルで process.env を読むので、server.ts の最初に import すること
import path from 'node:path';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
