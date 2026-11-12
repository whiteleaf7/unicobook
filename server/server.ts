// 小説フォルダ（UNICOBOOK_ROOT）を配信し、PWA 本体も配信するサーバー。
// 小説フォルダへの書き込みは、Gemini で作ったフォルダのアイコン（icon.png）を置くときと、前の画像を icon~N.png として残すときだけ。
// 127.0.0.1 だけで待ち受け、外からは `tailscale serve` 経由でアクセスする。

import './env.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { decodeText, plainLine, sourceLines } from '../public/aozora.js';
import { rejectReason } from './guard.ts';

const execFileAsync = promisify(execFile);

// 設定は環境変数（またはリポジトリ直下の .env）で変える。.env.example を参照
const env = (name: string) => process.env[name]?.trim() || undefined;
const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p);
const envPath = (name: string, fallback: string) => path.resolve(expandHome(env(name) ?? fallback));

if (!env('UNICOBOOK_ROOT')) {
  console.error('UNICOBOOK_ROOT に配信する小説フォルダを指定してください（.env.example を参照）');
  process.exit(1);
}
const ROOT = envPath('UNICOBOOK_ROOT', '');
const PORT = Number(env('UNICOBOOK_PORT') ?? 8787);
const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public');
const IMAGE_CACHE_DIR = envPath('UNICOBOOK_CACHE_DIR', '~/Library/Caches/unicobook');
// サーバーが持つユーザーデータの置き場所。小説フォルダには書き込まないよう、ここに保存する
const DATA_DIR = envPath('UNICOBOOK_DATA_DIR', '~/Library/Application Support/unicobook');
// アプリで選んだフォルダのアイコン（プリセットと、画像より優先するか）
const PRESETS_FILE = path.join(DATA_DIR, 'icons.json');
// 設定・読書位置・お気に入りなど、ブラウザ間で共有するユーザーデータ
const STORE_DB_FILE = path.join(DATA_DIR, 'store.db');

// フォルダのアイコンを作る Antigravity の CLI（サブスクの Gemini で画像を作る）。
// launchd は PATH を読まないので実体のパスで呼ぶ
const AGY = envPath('UNICOBOOK_AGY', '~/.local/bin/agy');
const AGY_MODEL = env('UNICOBOOK_AGY_MODEL') ?? 'gemini-3.8-flash-medium';
// agy を動かす作業フォルダ
const AGY_WORK_DIR = path.join(IMAGE_CACHE_DIR, 'generated');
// agy が会話ごとに作ったファイルを置く場所。Gemini が作った画像もここ（brain/<会話 ID>/）に置かれる
const AGY_BRAIN_DIR = envPath('UNICOBOOK_AGY_BRAIN_DIR', '~/.gemini/antigravity-cli/brain');
const GENERATED_IMAGE = /\.(png|jpe?g|webp)$/i;
// 作っている間にフォルダの icon.png として置く「仮」のアイコン（scripts/make-placeholder-icon.swift で生成）
const PLACEHOLDER_ICON = await readFile(path.resolve(import.meta.dirname, 'placeholder-icon.png'));

// これより大きい画像は縮小して返す（iPhone での表示とオフライン保存を軽くするため）。
// large は挿絵ビューで拡大して見る用。元画像が巨大でも iPhone が重くならない範囲に抑える
const IMAGE_LIMITS = {
  normal: { bytes: 800 * 1024, pixels: 2000, quality: 82 },
  large: { bytes: 3 * 1024 * 1024, pixels: 4096, quality: 88 },
  icon: { bytes: 64 * 1024, pixels: 192, quality: 85 },
};
type ImageLimit = (typeof IMAGE_LIMITS)[keyof typeof IMAGE_LIMITS];

// フォルダに置くとそのフォルダのアイコンになる画像（icon.png など）
const ICON_FILE = /^icon\.(png|jpe?g|webp|gif|heic)$/i;
// 作ったアイコンで置き換えた、フォルダの前の画像（icon~1.png, icon~2.png, …。番号が大きいほど新しい）
const OLD_ICON_FILE = /^icon~(\d+)\.(png|jpe?g|webp|gif|heic)$/i;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const rootReal = await realpath(ROOT);

// クライアントから来た相対パスを、ROOT の外に出ないことを確かめて実パスにする
async function resolveInRoot(rel: string | null): Promise<string> {
  const joined = path.resolve(rootReal, (rel ?? '').replace(/^\/+/, ''));
  let real: string;
  try {
    real = await realpath(joined);
  } catch {
    throw new HttpError(404, 'not found');
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new HttpError(403, 'forbidden');
  return real;
}

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function etagOf(size: number, mtimeMs: number) {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

// ETag で再検証させるので、変更がなければ 304 で済む
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, headers: Record<string, string> = {}) {
  const st = await stat(file);
  if (!st.isFile()) throw new HttpError(404, 'not found');
  const etag = etagOf(st.size, st.mtimeMs);
  const common = { ETag: etag, 'Cache-Control': 'no-cache', 'X-Mtime': String(Math.floor(st.mtimeMs)), ...headers };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, common);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(st.size),
    ...common,
  });
  createReadStream(file).pipe(res);
}

async function findIcon(dir: string): Promise<string | null> {
  try {
    return (await readdir(dir)).find((name) => ICON_FILE.test(name)) ?? null;
  } catch {
    return null;
  }
}

// フォルダの相対パス → 選んだプリセットの ID と、フォルダに置いた画像よりプリセットを優先するか
type IconSetting = { preset?: string; preferPreset?: true };
let presets: Record<string, IconSetting> = {};
try {
  const saved: Record<string, string | IconSetting> = JSON.parse(await readFile(PRESETS_FILE, 'utf8'));
  // 以前はプリセットの ID だけを保存していた
  for (const [key, value] of Object.entries(saved)) presets[key] = typeof value === 'string' ? { preset: value } : value;
} catch {
  // まだ選んでいない
}

async function savePresets() {
  await mkdir(path.dirname(PRESETS_FILE), { recursive: true });
  const tmp = `${PRESETS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(presets, null, 2));
  await rename(tmp, PRESETS_FILE);
}

interface StoreData {
  settings: Record<string, unknown>;
  positions: Record<string, unknown>;
  favorites: Record<string, number>;
  later: Record<string, number>;
  pins: Record<string, number>;
  folderSort: Record<string, string>;
  notes: Record<string, any>;
  summaries: Record<string, { markdown: string; updatedAt: number }>;
  baselines: Record<string, number[]>;
  baselineTexts: Record<string, string>;
}

await mkdir(path.dirname(STORE_DB_FILE), { recursive: true });
const storeDb = new DatabaseSync(STORE_DB_FILE);
storeDb.exec('PRAGMA journal_mode = WAL;');
storeDb.exec('PRAGMA synchronous = NORMAL;');
storeDb.exec(`
  CREATE TABLE IF NOT EXISTS store (
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (category, key)
  );
`);

const selectAllStoreStmt = storeDb.prepare('SELECT category, key, value FROM store');
const upsertStoreStmt = storeDb.prepare('INSERT OR REPLACE INTO store (category, key, value) VALUES (?, ?, ?)');
const deleteStoreStmt = storeDb.prepare('DELETE FROM store WHERE category = ? AND key = ?');

const initialStoreRows = selectAllStoreStmt.all() as { category: string; key: string; value: string }[];

const storeData: StoreData = {
  settings: {},
  positions: {},
  favorites: {},
  later: {},
  pins: {},
  folderSort: {},
  notes: {},
  summaries: {},
  baselines: {},
  baselineTexts: {},
};

for (const row of initialStoreRows) {
  try {
    const val = JSON.parse(row.value);
    if (row.category === 'settings') storeData.settings[row.key] = val;
    else if (row.category === 'positions') storeData.positions[row.key] = val;
    else if (row.category === 'favorites') storeData.favorites[row.key] = val;
    else if (row.category === 'later') storeData.later[row.key] = val;
    else if (row.category === 'pins') storeData.pins[row.key] = val;
    else if (row.category === 'folderSort') storeData.folderSort[row.key] = val;
    else if (row.category === 'notes') storeData.notes[row.key] = val;
    else if (row.category === 'summaries') storeData.summaries[row.key] = val;
    else if (row.category === 'baselines') storeData.baselines[row.key] = val;
    else if (row.category === 'baselineTexts') storeData.baselineTexts[row.key] = val;
  } catch {}
}

function mergeStore(patch: Record<string, any>) {
  storeDb.exec('BEGIN TRANSACTION');
  try {
    if (patch.settings && typeof patch.settings === 'object') {
      for (const [k, v] of Object.entries(patch.settings)) {
        storeData.settings[k] = v;
        upsertStoreStmt.run('settings', k, JSON.stringify(v));
      }
    }
    if (patch.positions && typeof patch.positions === 'object') {
      for (const [p, pos] of Object.entries(patch.positions)) {
        if (pos === null) {
          delete storeData.positions[p];
          deleteStoreStmt.run('positions', p);
        } else if (pos && typeof pos === 'object') {
          const cur = storeData.positions[p] as any;
          if (!cur || ((pos as any).updatedAt ?? 0) >= (cur.updatedAt ?? 0)) {
            storeData.positions[p] = pos;
            upsertStoreStmt.run('positions', p, JSON.stringify(pos));
          }
        }
      }
    }
    if (patch.favorites && typeof patch.favorites === 'object') {
      for (const [p, at] of Object.entries(patch.favorites)) {
        if (at === null || at === false) {
          delete storeData.favorites[p];
          deleteStoreStmt.run('favorites', p);
        } else if (typeof at === 'number') {
          storeData.favorites[p] = at;
          upsertStoreStmt.run('favorites', p, JSON.stringify(at));
        }
      }
    }
    if (patch.later && typeof patch.later === 'object') {
      for (const [p, at] of Object.entries(patch.later)) {
        if (at === null || at === false) {
          delete storeData.later[p];
          deleteStoreStmt.run('later', p);
        } else if (typeof at === 'number') {
          storeData.later[p] = at;
          upsertStoreStmt.run('later', p, JSON.stringify(at));
        }
      }
    }
    if (patch.pins && typeof patch.pins === 'object') {
      for (const [p, at] of Object.entries(patch.pins)) {
        if (at === null || at === false) {
          delete storeData.pins[p];
          deleteStoreStmt.run('pins', p);
        } else if (typeof at === 'number') {
          storeData.pins[p] = at;
          upsertStoreStmt.run('pins', p, JSON.stringify(at));
        }
      }
    }
    if (patch.folderSort && typeof patch.folderSort === 'object') {
      for (const [p, sortKey] of Object.entries(patch.folderSort)) {
        if (sortKey === null || sortKey === false) {
          delete storeData.folderSort[p];
          deleteStoreStmt.run('folderSort', p);
        } else if (typeof sortKey === 'string') {
          storeData.folderSort[p] = sortKey;
          upsertStoreStmt.run('folderSort', p, JSON.stringify(sortKey));
        }
      }
    }
    if (patch.notes && typeof patch.notes === 'object') {
      for (const [id, note] of Object.entries(patch.notes)) {
        if (note === null || note === false) {
          delete storeData.notes[id];
          deleteStoreStmt.run('notes', id);
        } else if (typeof note === 'object') {
          storeData.notes[id] = note;
          upsertStoreStmt.run('notes', id, JSON.stringify(note));
        }
      }
    }
    if (patch.baselines && typeof patch.baselines === 'object') {
      for (const [p, hashes] of Object.entries(patch.baselines)) {
        if (hashes === null) {
          delete storeData.baselines[p];
          deleteStoreStmt.run('baselines', p);
        } else if (Array.isArray(hashes)) {
          storeData.baselines[p] = hashes;
          upsertStoreStmt.run('baselines', p, JSON.stringify(hashes));
        }
      }
    }
    if (patch.baselineTexts && typeof patch.baselineTexts === 'object') {
      for (const [p, text] of Object.entries(patch.baselineTexts)) {
        if (text === null) {
          delete storeData.baselineTexts[p];
          deleteStoreStmt.run('baselineTexts', p);
        } else if (typeof text === 'string') {
          storeData.baselineTexts[p] = text;
          upsertStoreStmt.run('baselineTexts', p, JSON.stringify(text));
        }
      }
    }
    storeDb.exec('COMMIT');
  } catch (e) {
    storeDb.exec('ROLLBACK');
    console.error('Failed to update SQLite store:', e);
  }
}

function handleGetStore(res: ServerResponse) {
  const { baselineTexts, baselines, ...rest } = storeData;
  json(res, rest);
}

function handleGetBaseline(res: ServerResponse, rel: string | null) {
  if (!rel) throw new HttpError(400, 'missing path');
  const hashes = storeData.baselines[rel] ?? null;
  json(res, { hashes });
}

function handleGetBaselineText(res: ServerResponse, rel: string | null) {
  if (!rel) throw new HttpError(400, 'missing path');
  const text = storeData.baselineTexts[rel] ?? null;
  json(res, { text });
}

async function handlePostStore(req: IncomingMessage, res: ServerResponse) {
  let body: Record<string, any>;
  try {
    body = JSON.parse(await readBody(req, 10_000_000));
  } catch {
    throw new HttpError(400, 'invalid json');
  }
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid body');
  mergeStore(body);
  json(res, { ok: true });
}

// file はフォルダに置いた画像のファイル名で、version はその更新日時（画像が変わったら読み直させる）。
// preferPreset でなければ、画像をプリセットより優先して表示する。
// generating は Gemini でアイコンを作っている最中、generateError は前回作れなかった理由
type FolderIcon = IconSetting & { file?: string; version?: number; generating?: true; generateError?: string };

async function folderIcon(dir: string): Promise<FolderIcon | null> {
  const key = path.relative(rootReal, dir);
  const icon: FolderIcon = { ...presets[key] };
  const file = await findIcon(dir);
  if (file) {
    icon.file = file;
    icon.version = Math.floor((await stat(path.join(dir, file))).mtimeMs);
  }
  const job = iconJobs.get(key);
  if (job?.status === 'running') icon.generating = true;
  if (job?.status === 'error') icon.generateError = job.error;
  return Object.keys(icon).length ? icon : null;
}

// アイコンのあるシリーズ（小説フォルダ直下のフォルダ）。
// 続きを読むや各一覧で、作品の行にシリーズのアイコンを出すのに使う
async function seriesIcons(): Promise<Record<string, FolderIcon>> {
  const entries = await readdir(rootReal, { withFileTypes: true });
  const icons: Record<string, FolderIcon> = {};
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const icon = await folderIcon(path.join(rootReal, e.name));
    if (icon) icons[e.name] = icon;
  }
  return icons;
}

async function readBody(req: IncomingMessage, max = 10_000): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw new HttpError(413, 'too large');
  }
  return body;
}

async function handlePreset(req: IncomingMessage, res: ServerResponse, rel: string | null) {
  const dir = await iconFolder(rel);
  let body: { preset?: unknown; preferPreset?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    throw new HttpError(400, 'invalid json');
  }
  // 送られてきた項目だけを変える
  const key = path.relative(rootReal, dir);
  const setting: IconSetting = { ...presets[key] };
  const { preset, preferPreset } = body;
  if (preset === null) delete setting.preset;
  else if (typeof preset === 'string' && /^[a-z0-9-]+$/.test(preset)) setting.preset = preset;
  else if (preset !== undefined) throw new HttpError(400, 'invalid preset');
  if (preferPreset === true) setting.preferPreset = true;
  else if (preferPreset === false) delete setting.preferPreset;
  else if (preferPreset !== undefined) throw new HttpError(400, 'invalid preferPreset');
  if (Object.keys(setting).length) presets[key] = setting;
  else delete presets[key];
  await savePresets();
  json(res, { ok: true });
}

// アイコンを付けられるフォルダ（小説フォルダそのものは除く）
async function iconFolder(rel: string | null): Promise<string> {
  const dir = await resolveInRoot(rel);
  if (!(await stat(dir)).isDirectory() || dir === rootReal) throw new HttpError(400, 'not a folder');
  return dir;
}

// フォルダの相対パス → Gemini でアイコンを作っている最中か、作れなかった理由。サーバーを再起動すると忘れる
type IconJob = { status: 'running' } | { status: 'error'; error: string };
const iconJobs = new Map<string, IconJob>();

// フォルダ名（サブフォルダならシリーズ名から）と追加の指示で、Gemini にアイコンを作ってもらい、フォルダの icon.png にする。
// 1 枚に 2〜3 分かかるので、作り終わるのを待たずに返す。作っている間は「仮」のアイコンを置いておく。
// 前の画像はフォルダに icon~N.png として残し、フォルダの画像を表示したいはずなので、プリセットを優先する設定は外す
async function handleGenerateIcon(req: IncomingMessage, res: ServerResponse, rel: string | null) {
  const dir = await iconFolder(rel);
  let body: { hint?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    throw new HttpError(400, 'invalid json');
  }
  const hint = body.hint ?? '';
  if (typeof hint !== 'string' || hint.length > 500) throw new HttpError(400, 'invalid hint');
  const key = path.relative(rootReal, dir);
  if (iconJobs.get(key)?.status === 'running') throw new HttpError(409, 'このフォルダのアイコンは作成中です');
  iconJobs.set(key, { status: 'running' });
  let replaced: [string, string][];
  try {
    replaced = await moveIconsAway(dir);
    await writeFile(path.join(dir, 'icon.png'), PLACEHOLDER_ICON);
  } catch (e) {
    iconJobs.delete(key);
    throw e;
  }
  if (presets[key]?.preferPreset) {
    delete presets[key].preferPreset;
    if (!Object.keys(presets[key]).length) delete presets[key];
    await savePresets();
  }
  generateIcon(dir, key.split(path.sep).join(' / '), hint.trim(), replaced).then(
    () => iconJobs.delete(key),
    (e) => {
      console.error(e);
      iconJobs.set(key, { status: 'error', error: e.message });
    },
  );
  json(res, { ok: true });
}

// フォルダの画像を、いちばん新しい履歴の次の番号の icon~N.png にし、[元の場所, 移した先] を返す
async function moveIconsAway(dir: string): Promise<[string, string][]> {
  const files = await readdir(dir);
  let last = Math.max(0, ...files.map((name) => Number(OLD_ICON_FILE.exec(name)?.[1] ?? 0)));
  const moved: [string, string][] = [];
  for (const name of files.filter((name) => ICON_FILE.test(name))) {
    const to = path.join(dir, `icon~${++last}${path.extname(name)}`);
    await rename(path.join(dir, name), to);
    moved.push([path.join(dir, name), to]);
  }
  return moved;
}

async function isPlaceholder(file: string): Promise<boolean> {
  return (await readFile(file).catch(() => null))?.equals(PLACEHOLDER_ICON) ?? false;
}

async function generateIcon(dir: string, title: string, hint: string, replaced: [string, string][]) {
  const icon = path.join(dir, 'icon.png');
  const prompt = [
    `Generate an image: a minimal logo mark for a Japanese novel series titled "${title}", used as a tiny list icon (about 40px).`,
    'One single, simple symbol in flat vector style: thick shapes, 2-3 colors, no gradients, no fine details, no scenery.',
    'Make the symbol large and centered, filling about 85% of the square canvas with only a small margin.',
    'Plain solid-color background that fills the whole canvas: no patterns, stars or textures, no rounded-square frame, no border, no shadow, no text.',
    hint ? `Additional instructions (these take priority): ${hint}` : '',
    // 手元のツールを探したり、サンドボックスの外へ画像を書き出そうとしたりして手数（＝トークン）が増えるので、
    // サブエージェントを呼んで待つだけにさせる。形式の変換や置き場所はサーバー側で面倒を見る。
    // また、サブエージェントの完了を待たずに返事をして終わることがあるので、作り終えるまで待たせる
    'Call the image-generator subagent right away. Do not look for local tools or write any code.',
    'This is a one-shot non-interactive run: you cannot be notified later, so wait for the subagent to finish in this turn.',
    'Do not convert, copy or move the generated image. Reply with only the absolute path of the image file as generated.',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const generated = await runAgy(prompt);
    // 作っている間に icon.png が差し替えられていたら、そちらを残す
    if (!(await isPlaceholder(icon))) return;
    const tmp = path.join(dir, '.icon-generating.png');
    await execFileAsync('sips', ['-Z', '512', '-s', 'format', 'png', generated, '--out', tmp]);
    await rename(tmp, icon);
  } catch (e) {
    // 作れなかったら、仮のアイコンを外して前の画像を戻す
    if (await isPlaceholder(icon)) {
      await unlink(icon);
      for (const [from, to] of replaced) await rename(to, from);
    }
    throw e;
  }
}

// agy にプロンプトを渡し、テキストの返答（Markdown）を返す
async function runAgyPrompt(prompt: string): Promise<string> {
  await mkdir(AGY_WORK_DIR, { recursive: true });
  const args = ['--print', prompt, '--model', AGY_MODEL, '--output-format', 'json', '--dangerously-skip-permissions', '--sandbox', '--print-timeout', '180s'];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(AGY, args, { cwd: AGY_WORK_DIR, timeout: 200_000, maxBuffer: 10 * 1024 * 1024 }));
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') throw new Error(`agy が見つかりません（${AGY}）`);
    if (err.killed) throw new Error('時間内に生成が終わりませんでした');
    throw new Error(`agy が失敗しました: ${(err.stderr ?? '').trim().slice(-300) || `終了コード ${err.code}`}`);
  }
  let result: { response?: string } = {};
  try {
    result = JSON.parse(stdout);
  } catch {}
  const response = (result.response ?? stdout).trim();
  if (!response) throw new Error('返答が得られませんでした');
  return response;
}

const SETTING_FILE_PATTERN = /(キャラ|ロードマップ|設定|シート|roadmap|character|profile|setting)/i;
const EXCLUDE_FILE_PATTERN = /(プロット|plot|^[0-9]+[_\-話巻])/i;

async function findSettingFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: { name: string; fullPath: string }[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (EXCLUDE_FILE_PATTERN.test(e.name)) continue;
    if (SETTING_FILE_PATTERN.test(e.name) && /\.(txt|md)$/i.test(e.name)) {
      files.push({ name: e.name, fullPath: path.join(e.parentPath, e.name) });
    }
  }
  return files;
}

async function handleGetSummary(res: ServerResponse, rel: string | null) {
  const dir = await resolveInRoot(rel);
  const key = path.relative(rootReal, dir);
  json(res, { summary: storeData.summaries[key] ?? null });
}

async function handleGenerateSummary(req: IncomingMessage, res: ServerResponse, rel: string | null) {
  const dir = await resolveInRoot(rel);
  const key = path.relative(rootReal, dir);
  const settingFiles = await findSettingFiles(dir);
  if (!settingFiles.length) {
    throw new HttpError(
      400,
      '設定資料が見つかりませんでした（全体ロードマップやキャラシートなど、ファイル名に「ロードマップ」「キャラ」「設定」「シート」等を含む .txt または .md をフォルダ内に置いてください）',
    );
  }

  let combined = '';
  for (const sf of settingFiles) {
    const raw = await readFile(sf.fullPath);
    const text = decodeText(raw);
    combined += `\n\n--- 資料: ${sf.name} ---\n${text.slice(0, 30000)}`;
  }

  const seriesTitle = path.basename(dir) || '作品';
  const prompt = [
    `あなたは小説の編集者です。以下のシリーズ「${seriesTitle}」の設定資料（全体ロードマップやキャラクターシート）から、`,
    '読書や執筆推敲の助けとなる「あらすじ・全体概要」と「主な登場人物一覧」を簡潔な日本語の Markdown 形式でまとめてください。',
    '',
    '## 出力形式',
    '### 【あらすじ・作品概要】',
    '（全体の世界観と主要な物語の導入・流れを 300〜500 字程度で簡潔に）',
    '',
    '### 【主な登場人物】',
    '（主要キャラクターの名前、簡単なプロフィール、特徴、関係性を箇条書きで）',
    '',
    '※注意事項：',
    '- 本文や各話プロットは含まれていません。渡された設定資料のみをもとに整理してください。',
    '- 各話の詳細なネタバレは避け、設定・導入に留めてください。',
    '',
    combined,
  ].join('\n');

  const markdown = await runAgyPrompt(prompt);
  const summaryObj = { markdown, updatedAt: Date.now() };
  storeData.summaries[key] = summaryObj;
  upsertStoreStmt.run('summaries', key, JSON.stringify(summaryObj));
  json(res, { summary: summaryObj });
}

// agy に画像を作らせ、できた画像のパスを返す
async function runAgy(prompt: string): Promise<string> {
  await mkdir(AGY_WORK_DIR, { recursive: true });
  const args = ['--print', prompt, '--model', AGY_MODEL, '--output-format', 'json', '--dangerously-skip-permissions', '--sandbox', '--print-timeout', '300s'];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(AGY, args, { cwd: AGY_WORK_DIR, timeout: 330_000, maxBuffer: 10 * 1024 * 1024 }));
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') throw new Error(`agy が見つかりません（${AGY}）`);
    if (err.killed) throw new Error('時間内に作り終わりませんでした');
    throw new Error(`agy が失敗しました: ${(err.stderr ?? '').trim().slice(-300) || `終了コード ${err.code}`}`);
  }
  let result: { conversation_id?: string; response?: string } = {};
  try {
    result = JSON.parse(stdout);
  } catch {
    // JSON でなければ、下で返事をそのままエラーに出す
  }
  const response = (result.response ?? stdout).trim();
  // パスだけと頼んでも前置きを付けてくることがあるので、パスらしい最後の行を使う
  const pathLine = response.split('\n').map((line) => line.trim()).findLast((line) => path.isAbsolute(line)) ?? '';
  const image = (await generatedImage(pathLine)) ?? (result.conversation_id && (await latestGeneratedImage(result.conversation_id)));
  if (!image) throw new Error(`画像ができませんでした: ${response.slice(0, 300)}`);
  return image;
}

// 返事に書かれたパスが、agy の作った画像なら実パスを返す（返事のパスのファイルを何でも読んでしまわないよう、brain の下に限る）
async function generatedImage(file: string): Promise<string | null> {
  if (!path.isAbsolute(file) || !GENERATED_IMAGE.test(file)) return null;
  const real = await realpath(file).catch(() => null);
  const brain = await realpath(AGY_BRAIN_DIR).catch(() => null);
  if (!real || !brain || !real.startsWith(brain + path.sep)) return null;
  return (await stat(real)).isFile() ? real : null;
}

// 返事がパスになっていなかったときのために、その会話で作られたいちばん新しい画像を探す
async function latestGeneratedImage(conversationId: string): Promise<string | null> {
  if (!/^[0-9a-f-]+$/i.test(conversationId)) return null;
  const dir = path.join(AGY_BRAIN_DIR, conversationId);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let latest: { file: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isFile() || !GENERATED_IMAGE.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const { mtimeMs } = await stat(file);
    if (!latest || mtimeMs > latest.mtime) latest = { file, mtime: mtimeMs };
  }
  return latest?.file ?? null;
}

async function handleList(res: ServerResponse, rel: string | null) {
  const dir = await resolveInRoot(rel);
  const entries = await readdir(dir, { withFileTypes: true });
  const dirs: { name: string; icon: FolderIcon | null; texts: { path: string; mtime: number }[] }[] = [];
  const files: { name: string; size: number; mtime: number }[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      const sub = path.join(dir, e.name);
      // 中の話の数と読了数、読んだあとに更新された話があるか（読書位置は iPhone にあるのでアプリで数える）を出すため、
      // 下のテキストファイルを更新日時つきで返す
      dirs.push({ name: e.name, icon: await folderIcon(sub), texts: await withMtimes(await textFilesUnder(sub)) });
    } else if (e.name.toLowerCase().endsWith('.txt')) {
      const st = await stat(path.join(dir, e.name));
      files.push({ name: e.name, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }
  }
  json(res, {
    root: path.basename(rootReal),
    path: path.relative(rootReal, dir),
    dirs,
    files,
    seriesIcons: await seriesIcons(),
  });
}

// フォルダを横断して、更新日時が新しい順にテキストファイルを返す
// dir の下（サブフォルダも含む）のテキストファイルの、小説フォルダからの相対パス
async function textFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.txt')) continue;
    const rel = path.relative(rootReal, path.join(e.parentPath, e.name));
    if (!rel.split(path.sep).some((seg) => seg.startsWith('.'))) files.push(rel);
  }
  return files;
}

async function withMtimes(rels: string[]): Promise<{ path: string; mtime: number }[]> {
  const texts = [];
  for (const rel of rels) texts.push({ path: rel, mtime: Math.floor((await stat(path.join(rootReal, rel))).mtimeMs) });
  return texts;
}

// 続きを読む・履歴・印の一覧・検索結果のように、アプリが覚えているパスから描く一覧で更新の印を付けるため、
// 送られてきたパスごとに、ファイルならそれ自身、フォルダなら下（サブフォルダも含む）のテキストファイルを更新日時つきで返す。
// 消えたパスは返さない
async function handleTexts(req: IncomingMessage, res: ServerResponse) {
  let body: { paths?: unknown };
  try {
    body = JSON.parse(await readBody(req, 200_000));
  } catch {
    throw new HttpError(400, 'invalid json');
  }
  if (!Array.isArray(body.paths) || !body.paths.every((p) => typeof p === 'string')) throw new HttpError(400, 'invalid paths');
  const texts: Record<string, { path: string; mtime: number }[]> = {};
  for (const rel of body.paths as string[]) {
    const real = await resolveInRoot(rel).catch(() => null);
    if (!real) continue;
    const st = await stat(real);
    if (st.isDirectory()) texts[rel] = await withMtimes(await textFilesUnder(real));
    else if (st.isFile()) texts[rel] = [{ path: rel, mtime: Math.floor(st.mtimeMs) }];
  }
  json(res, { texts });
}

async function handleRecent(res: ServerResponse, limit: number) {
  const files: { path: string; mtime: number }[] = [];
  for (const rel of await textFilesUnder(rootReal)) {
    const st = await stat(path.join(rootReal, rel));
    files.push({ path: rel, mtime: Math.floor(st.mtimeMs) });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  json(res, { root: path.basename(rootReal), files: files.slice(0, limit), seriesIcons: await seriesIcons() });
}

// 横断検索のために、テキストファイルを検索用の行に分けたものを更新日時ごとに覚えておく
const searchCache = new Map<string, { mtime: number; lines: string[] }>();

async function searchLines(rel: string): Promise<string[]> {
  const file = path.join(rootReal, rel);
  const st = await stat(file);
  const cached = searchCache.get(rel);
  if (cached && cached.mtime === st.mtimeMs) return cached.lines;
  const lines = sourceLines(decodeText(await readFile(file))).map(plainLine);
  searchCache.set(rel, { mtime: st.mtimeMs, lines });
  return lines;
}

const SEARCH_LIMIT = 300;
const SEARCH_PER_FILE = 30;

// 小説フォルダ全体（rel を渡したときはそのフォルダの中）から q を探す。大文字と小文字は区別しない
async function handleSearch(res: ServerResponse, q: string, rel: string | null) {
  const query = q.trim().toLowerCase();
  if (!query) throw new HttpError(400, 'empty query');
  const dir = rel ? await resolveInRoot(rel) : rootReal;
  if (!(await stat(dir)).isDirectory()) throw new HttpError(400, 'not a directory');
  const files = (await textFilesUnder(dir)).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  const results: { path: string; line: number; snippet: string; at: number }[] = [];
  let truncated = false;
  for (const rel of files) {
    const lines = await searchLines(rel);
    let inFile = 0;
    for (let i = 0; i < lines.length && inFile < SEARCH_PER_FILE; i++) {
      const at = lines[i].toLowerCase().indexOf(query);
      if (at < 0) continue;
      const from = Math.max(0, at - 20);
      results.push({ path: rel, line: i, snippet: lines[i].slice(from, at + query.length + 30), at: at - from });
      inFile++;
    }
    if (results.length >= SEARCH_LIMIT) {
      truncated = true;
      break;
    }
  }
  json(res, { root: path.basename(rootReal), results: results.slice(0, SEARCH_LIMIT), truncated, seriesIcons: await seriesIcons() });
}

async function handleStat(res: ServerResponse, rel: string | null) {
  const st = await stat(await resolveInRoot(rel));
  json(res, { size: st.size, mtime: Math.floor(st.mtimeMs) });
}

const alphaCache = new Map<string, boolean>();

async function hasAlpha(file: string, key: string): Promise<boolean> {
  let alpha = alphaCache.get(key);
  if (alpha === undefined) {
    const { stdout } = await execFileAsync('sips', ['-g', 'hasAlpha', file]);
    alpha = /hasAlpha:\s*yes/.test(stdout);
    alphaCache.set(key, alpha);
  }
  return alpha;
}

async function handleImage(req: IncomingMessage, res: ServerResponse, rel: string | null, size: string | null) {
  await sendImage(req, res, await resolveInRoot(rel), size === 'large' ? IMAGE_LIMITS.large : IMAGE_LIMITS.normal);
}

async function handleIcon(req: IncomingMessage, res: ServerResponse, rel: string | null) {
  const dir = await resolveInRoot(rel);
  const name = await findIcon(dir);
  if (!name) throw new HttpError(404, 'no icon');
  await sendImage(req, res, path.join(dir, name), IMAGE_LIMITS.icon);
}

async function sendImage(req: IncomingMessage, res: ServerResponse, file: string, limit: ImageLimit) {
  const st = await stat(file);
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]?.startsWith('image/')) throw new HttpError(400, 'not an image');
  if (st.size <= limit.bytes || ext === '.gif' || ext === '.svg') {
    await sendFile(req, res, file);
    return;
  }
  // 縮小版は元ファイルのパス・サイズ・更新日時と縮小後の大きさをキーにキャッシュする
  const key = createHash('sha1').update(`${file}\0${st.size}\0${st.mtimeMs}\0${limit.pixels}`).digest('hex');
  // PNG のまま縮小すると大きくなるので、透過がなければ JPEG にする
  const outExt = ext === '.png' && (await hasAlpha(file, key)) ? '.png' : '.jpg';
  const cached = path.join(IMAGE_CACHE_DIR, key + outExt);
  try {
    await stat(cached);
  } catch {
    await mkdir(IMAGE_CACHE_DIR, { recursive: true });
    const format = outExt === '.png' ? ['png'] : ['jpeg', '--setProperty', 'formatOptions', String(limit.quality)];
    await execFileAsync('sips', ['-Z', String(limit.pixels), '-s', 'format', ...format, file, '--out', cached]);
  }
  await sendFile(req, res, cached);
}

async function handleStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'forbidden');
  try {
    await sendFile(req, res, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'not found');
    throw e;
  }
}

const server = createServer(async (req, res) => {
  try {
    const rejected = rejectReason(req.method, req.headers);
    if (rejected) throw new HttpError(403, rejected);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = url.searchParams.get('path');
    if (req.method === 'POST') {
      switch (url.pathname) {
        case '/api/store':
          return await handlePostStore(req, res);
        case '/api/preset':
          return await handlePreset(req, res, rel);
        case '/api/icon/generate':
          return await handleGenerateIcon(req, res, rel);
        case '/api/summary':
          return await handleGenerateSummary(req, res, rel);
        case '/api/texts':
          return await handleTexts(req, res);
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    switch (url.pathname) {
      case '/api/store':
        return handleGetStore(res);
      case '/api/baseline':
        return handleGetBaseline(res, rel);
      case '/api/baseline-text':
        return handleGetBaselineText(res, rel);
      case '/api/summary':
        return await handleGetSummary(res, rel);
      case '/api/list':
        return await handleList(res, rel);
      case '/api/recent':
        return await handleRecent(res, Math.min(Number(url.searchParams.get('limit')) || 30, 200));
      case '/api/search':
        return await handleSearch(res, url.searchParams.get('q') ?? '', rel);
      case '/api/stat':
        return await handleStat(res, rel);
      case '/api/file':
        return await sendFile(req, res, await resolveInRoot(rel));
      case '/api/icon':
        return await handleIcon(req, res, rel);
      case '/api/image':
        return await handleImage(req, res, rel, url.searchParams.get('size'));
      default:
        return await handleStatic(req, res, url.pathname);
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e instanceof Error ? e.message : 'error');
  }
});

async function cleanNonExistentPositions() {
  try {
    const allTexts = new Set(await textFilesUnder(rootReal));
    const entries = await readdir(rootReal, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.txt')) {
        allTexts.add(e.name);
      }
    }
    const toDelete = Object.keys(storeData.positions).filter((p) => !allTexts.has(p));
    if (toDelete.length > 0) {
      storeDb.exec('BEGIN TRANSACTION');
      try {
        for (const p of toDelete) {
          delete storeData.positions[p];
          deleteStoreStmt.run('positions', p);
        }
        storeDb.exec('COMMIT');
        console.log(`Cleaned ${toDelete.length} non-existent positions:`, toDelete);
      } catch (e) {
        storeDb.exec('ROLLBACK');
        console.error('Failed to clean non-existent positions:', e);
      }
    }
  } catch (e) {
    console.error('Error during cleanNonExistentPositions:', e);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`unicobook: http://127.0.0.1:${PORT}/ (root: ${rootReal})`);
  cleanNonExistentPositions();
});
