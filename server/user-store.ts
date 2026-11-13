// 設定・読書位置・お気に入りなど、ブラウザ間で共有するユーザーデータを SQLite に保存する。
// 起動時にすべて読み込んでメモリに持ち、変わったら SQLite にも書く
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { STORE_DB_FILE } from './config.ts';

const isObject = (v: unknown) => typeof v === 'object' && v !== null;

// クライアントが書き換えられる種類と、保存してよい値か
const WRITABLE = {
  settings: () => true,
  // ファイルの相対パス → 読書位置 { line, off, snippet, page, pages, mtime, updatedAt }
  positions: isObject,
  // お気に入り・後で読む・ピン留め。相対パス → 付けた日時
  favorites: (v: unknown) => typeof v === 'number',
  later: (v: unknown) => typeof v === 'number',
  pins: (v: unknown) => typeof v === 'number',
  // フォルダの相対パス → 一覧の並び順
  folderSort: (v: unknown) => typeof v === 'string',
  // 付箋の ID → 付箋
  notes: isObject,
  // 変更箇所の印の基準にする、前回の本文の行ごとの指紋と本文の全文。大きいので一括の取得には含めない
  baselines: Array.isArray,
  baselineTexts: (v: unknown) => typeof v === 'string',
} satisfies Record<string, (v: unknown) => boolean>;

type WritableCategory = keyof typeof WRITABLE;
// summaries はサーバーが作ったあらすじ（フォルダの相対パス → { markdown, updatedAt }）
type Category = WritableCategory | 'summaries';
const CATEGORIES: Category[] = ['settings', 'positions', 'favorites', 'later', 'pins', 'folderSort', 'notes', 'summaries', 'baselines', 'baselineTexts'];

await mkdir(path.dirname(STORE_DB_FILE), { recursive: true });
const db = new DatabaseSync(STORE_DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS store (
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (category, key)
  );
`);
const upsertStmt = db.prepare('INSERT OR REPLACE INTO store (category, key, value) VALUES (?, ?, ?)');
const deleteStmt = db.prepare('DELETE FROM store WHERE category = ? AND key = ?');

const data = Object.fromEntries(CATEGORIES.map((c) => [c, {}])) as Record<Category, Record<string, unknown>>;
for (const row of db.prepare('SELECT category, key, value FROM store').all() as { category: string; key: string; value: string }[]) {
  if (!(CATEGORIES as string[]).includes(row.category)) continue;
  try {
    data[row.category as Category][row.key] = JSON.parse(row.value);
  } catch {
    // 壊れた値は読み飛ばす
  }
}

function inTransaction(run: () => void) {
  db.exec('BEGIN TRANSACTION');
  try {
    run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getValue(category: Category, key: string): unknown {
  return data[category][key];
}

export function putValue(category: Category, key: string, value: unknown) {
  data[category][key] = value;
  upsertStmt.run(category, key, JSON.stringify(value));
}

function deleteValue(category: Category, key: string) {
  delete data[category][key];
  deleteStmt.run(category, key);
}

export function keysOf(category: Category): string[] {
  return Object.keys(data[category]);
}

export function deleteValues(category: Category, keys: string[]) {
  inTransaction(() => {
    for (const key of keys) deleteValue(category, key);
  });
}

// クライアントにまとめて返すユーザーデータ（大きい baselines と baselineTexts は除く）
export function snapshot() {
  const { baselines, baselineTexts, ...rest } = data;
  return rest;
}

// クライアントから来た変更 { 種類: { キー: 値 } } を取り込む。値が null か false なら消す。
// 読書位置は、すでにあるものより古ければ取り込まない（別の端末でもっと後に保存された位置を守るため）
export function applyPatch(patch: Record<string, unknown>) {
  try {
    inTransaction(() => {
      for (const [category, isValid] of Object.entries(WRITABLE) as [WritableCategory, (v: unknown) => boolean][]) {
        const entries = patch[category];
        if (!isObject(entries)) continue;
        for (const [key, value] of Object.entries(entries as object)) {
          if (value === null || value === false) {
            deleteValue(category, key);
          } else if (isValid(value) && !(category === 'positions' && isOlder(value, data.positions[key]))) {
            putValue(category, key, value);
          }
        }
      }
    });
  } catch (e) {
    console.error('Failed to update SQLite store:', e);
  }
}

const updatedAtOf = (v: unknown) => (v as { updatedAt?: number } | undefined)?.updatedAt ?? 0;
const isOlder = (next: unknown, current: unknown) => current !== undefined && updatedAtOf(next) < updatedAtOf(current);
