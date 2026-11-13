// 小説フォルダの中のファイルを扱う道具。パスはどれも小説フォルダからの相対パス
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './config.ts';
import { HttpError, mtimeOf } from './http.ts';

export type TextFile = { path: string; mtime: number };

export const isTextFile = (name: string) => name.toLowerCase().endsWith('.txt');

export const relativeToRoot = (file: string) => path.relative(ROOT, file);

// クライアントから来た相対パスを、小説フォルダの外に出ないことを確かめて実パスにする
export async function resolveInRoot(rel: string | null): Promise<string> {
  const joined = path.resolve(ROOT, (rel ?? '').replace(/^\/+/, ''));
  let real: string;
  try {
    real = await realpath(joined);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new HttpError(403, 'forbidden');
  return real;
}

// dir の下（サブフォルダも含む）のテキストファイル。. で始まるファイルやフォルダの中は除く
export async function textFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !isTextFile(e.name)) continue;
    const rel = relativeToRoot(path.join(e.parentPath, e.name));
    if (!rel.split(path.sep).some((seg) => seg.startsWith('.'))) files.push(rel);
  }
  return files;
}

export async function withMtimes(rels: string[]): Promise<TextFile[]> {
  const texts: TextFile[] = [];
  for (const rel of rels) texts.push({ path: rel, mtime: mtimeOf(await stat(path.join(ROOT, rel))) });
  return texts;
}
