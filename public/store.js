// 設定・読書位置・最後に開いていた画面を localStorage に保存し、Mac 上のサーバーとも同期する

import { fetchStore, saveStorePatch, fetchBaseline, fetchBaselineText } from './api.js';

const KEY_SETTINGS = 'nb.settings';
const KEY_POSITIONS = 'nb.positions';
const KEY_ROUTE = 'nb.route';

// 広い画面では、ページが横に広がりすぎて読みにくくならないよう左右の余白を大きくする
export const WIDE_QUERY = matchMedia('(min-width: 800px) and (min-height: 600px)');

export const DEFAULT_SETTINGS = {
  fontSize: 18,
  lineHeight: 1.8,
  marginBlockEm: 1.5,
  marginInlineEm: WIDE_QUERY.matches ? 8 : 1,
  font: 'mincho',
  theme: 'light',
};

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

let pendingPatch = {};
let pushTimer = null;
let isPushing = false;
let pushRetryCount = 0;
const MAX_RETRY_DELAY_MS = 30000;

function schedulePush(patch = null, delay = 400) {
  if (patch) {
    if (patch.positions) pendingPatch.positions = { ...pendingPatch.positions, ...patch.positions };
    if (patch.favorites) pendingPatch.favorites = { ...pendingPatch.favorites, ...patch.favorites };
    if (patch.later) pendingPatch.later = { ...pendingPatch.later, ...patch.later };
    if (patch.pins) pendingPatch.pins = { ...pendingPatch.pins, ...patch.pins };
    if (patch.folderSort) pendingPatch.folderSort = { ...pendingPatch.folderSort, ...patch.folderSort };
    if (patch.notes) pendingPatch.notes = { ...pendingPatch.notes, ...patch.notes };
    if (patch.baselines) pendingPatch.baselines = { ...pendingPatch.baselines, ...patch.baselines };
    if (patch.baselineTexts) pendingPatch.baselineTexts = { ...pendingPatch.baselineTexts, ...patch.baselineTexts };
  }

  clearTimeout(pushTimer);
  pushTimer = setTimeout(flushPush, delay);
}

export async function flushPush() {
  clearTimeout(pushTimer);
  pushTimer = null;
  flushPositions();
  if (isPushing || !Object.keys(pendingPatch).length) return;

  const payload = pendingPatch;
  pendingPatch = {};
  isPushing = true;

  try {
    await saveStorePatch(payload);
    pushRetryCount = 0;
  } catch {
    // 失敗時は次回送信のために未送信分を戻す（指数バックオフで再送）
    const delay = Math.min(1000 * 2 ** pushRetryCount, MAX_RETRY_DELAY_MS);
    pushRetryCount++;
    schedulePush(payload, delay);
  } finally {
    isPushing = false;
    // 送信中に新しい変更が入っていたら、さらにフラッシュをスケジュール
    if (Object.keys(pendingPatch).length && !pushTimer) {
      pushTimer = setTimeout(flushPush, 400);
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPositions();
      flushPush();
    }
  });
  window.addEventListener('pagehide', () => {
    flushPositions();
    flushPush();
  });
  window.addEventListener('online', () => {
    if (Object.keys(pendingPatch).length) {
      pushRetryCount = 0;
      schedulePush(null, 100);
    }
  });
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(KEY_SETTINGS, {}) };
}

// 表示設定は画面サイズや端末ごとに異なるため、サーバー同期せず端末（localStorage）のみに保存する
export function saveSettings(settings) {
  write(KEY_SETTINGS, settings);
}

let positionsCache = null;
let writePositionsTimer = null;

export function getPositions() {
  positionsCache ??= read(KEY_POSITIONS, {});
  return positionsCache;
}

export function flushPositions() {
  if (writePositionsTimer) {
    clearTimeout(writePositionsTimer);
    writePositionsTimer = null;
    if (positionsCache) write(KEY_POSITIONS, positionsCache);
  }
}

function scheduleWritePositions() {
  if (writePositionsTimer) return;
  writePositionsTimer = setTimeout(() => {
    writePositionsTimer = null;
    if (positionsCache) write(KEY_POSITIONS, positionsCache);
  }, 300);
}

// 位置は { line, off, snippet, page, pages, mtime, updatedAt }
export function getPosition(path) {
  return getPositions()[path] ?? null;
}

export function setPosition(path, pos) {
  const all = getPositions();
  const entry = { ...pos, updatedAt: Date.now() };
  all[path] = entry;
  scheduleWritePositions();
  schedulePush({ positions: { [path]: entry } });
  return entry;
}

export function deletePositions(paths) {
  const all = getPositions();
  const patch = {};
  let changed = false;
  for (const path of paths) {
    if (path in all) {
      delete all[path];
      patch[path] = null;
      changed = true;
    }
  }
  if (changed) {
    scheduleWritePositions();
    schedulePush({ positions: patch });
  }
}

export function deletePosition(path) {
  deletePositions([path]);
}

// 最後に開いた順に n 件
export function getRecent(n = Infinity) {
  const items = Object.entries(getPositions())
    .map(([path, pos]) => ({ path, pos }))
    .sort((a, b) => (b.pos.updatedAt ?? 0) - (a.pos.updatedAt ?? 0));
  return Number.isFinite(n) ? items.slice(0, n) : items;
}

// お気に入り（favorite）と後で読む（later）の印。フォルダ・ファイルの相対パスに、印を付けた日時を持つ
const MARK_KEYS = { favorite: 'nb.favorites', later: 'nb.later' };

function readMarks(kind) {
  const data = read(MARK_KEYS[kind], {});
  // 以前はお気に入りをパスの配列で持っていたので、付けた順番を保って日時に置き換える
  if (Array.isArray(data)) {
    const now = Date.now();
    return Object.fromEntries(data.map((path, i) => [path, now - (data.length - i)]));
  }
  return data;
}

export function isMarked(kind, path) {
  return path in readMarks(kind);
}

export function toggleMark(kind, path) {
  const marks = readMarks(kind);
  const on = !(path in marks);
  const key = kind === 'favorite' ? 'favorites' : 'later';
  if (on) {
    const now = Date.now();
    marks[path] = now;
    schedulePush({ [key]: { [path]: now } });
  } else {
    delete marks[path];
    schedulePush({ [key]: { [path]: null } });
  }
  write(MARK_KEYS[kind], marks);
  return on;
}

// 印を付けた日時が新しい順
export function getMarked(kind) {
  return Object.entries(readMarks(kind))
    .map(([path, at]) => ({ path, at }))
    .sort((a, b) => b.at - a.at);
}

// ピン留め（各フォルダ内の上部に固定表示する項目）。パス → ピン留めした日時
const KEY_PINS = 'nb.pins';

export function getPins() {
  return read(KEY_PINS, {});
}

export function isPinned(path) {
  return path in getPins();
}

export function togglePin(path) {
  const pins = getPins();
  const on = !(path in pins);
  if (on) {
    const now = Date.now();
    pins[path] = now;
    schedulePush({ pins: { [path]: now } });
  } else {
    delete pins[path];
    schedulePush({ pins: { [path]: null } });
  }
  write(KEY_PINS, pins);
  return on;
}

// フォルダごとのソート設定。フォルダの相対パス → ソートキー ('name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc' | 'progress')
const KEY_FOLDER_SORT = 'nb.folderSort';

export function getFolderSort(folderPath) {
  const data = read(KEY_FOLDER_SORT, {});
  return data[folderPath] ?? 'name-asc';
}

export function setFolderSort(folderPath, sortKey) {
  const data = read(KEY_FOLDER_SORT, {});
  data[folderPath] = sortKey;
  write(KEY_FOLDER_SORT, data);
  schedulePush({ folderSort: { [folderPath]: sortKey } });
}

// 付箋（推敲メモ）。ノートID → { id, path, line, snippet, text, createdAt, updatedAt }
const KEY_NOTES = 'nb.notes';

export function getNotes() {
  return read(KEY_NOTES, {});
}

export function getNotesForPath(path) {
  return Object.values(getNotes())
    .filter((n) => n.path === path)
    .sort((a, b) => a.line - b.line || (a.off ?? 0) - (b.off ?? 0));
}

export function getAllNotes() {
  return Object.values(getNotes()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveNote({ id, path, line, off, snippet, text }) {
  const notes = getNotes();
  const now = Date.now();
  const noteId = id ?? `n_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const existing = notes[noteId];
  const note = {
    id: noteId,
    path,
    line,
    off: off ?? existing?.off ?? 0,
    snippet: snippet ?? existing?.snippet ?? '',
    text: text ?? '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  notes[noteId] = note;
  write(KEY_NOTES, notes);
  schedulePush({ notes: { [noteId]: note } });
  return note;
}

export function deleteNote(id) {
  const notes = getNotes();
  delete notes[id];
  write(KEY_NOTES, notes);
  schedulePush({ notes: { [id]: null } });
}

// アイコンのあるシリーズ（名前 → { file: true } か { preset: ID }）。
// 印の一覧などサーバーに聞かずに描く画面でも使えるよう覚えておく
export function getSeriesIcons() {
  const data = read('nb.seriesIcons', {});
  // 以前は画像を置いたシリーズの名前の配列だった
  return Array.isArray(data) ? Object.fromEntries(data.map((name) => [name, { file: true }])) : data;
}

export function setSeriesIcons(icons) {
  if (icons && typeof icons === 'object') write('nb.seriesIcons', icons);
}

export function getLastRoute() {
  return localStorage.getItem(KEY_ROUTE);
}

export function setLastRoute(route) {
  localStorage.setItem(KEY_ROUTE, route);
}

// 起点の指紋（ハッシュ値）は端末には保存せず、サーバーから取得する
export async function getBaseline(path) {
  return await fetchBaseline(path);
}

export function setBaseline(path, hashes) {
  schedulePush({ baselines: { [path]: hashes } });
}

// 起点の本文テキスト全文は端末（IndexedDB）には保存せず、サーバーからオンデマンドで取得する
export async function getBaselineText(path) {
  return await fetchBaselineText(path);
}

export function setBaselineText(path, text) {
  schedulePush({ baselineTexts: { [path]: text } });
}

// 同期の最中なら、その完了を待つ Promise（長くかかるときは待たずに進む）。
// 開いた話の読書位置を決める前に、他の端末の位置を取り込んでおくために使う
let syncing = null;
export function syncSettled(timeoutMs = 2000) {
  if (!syncing) return Promise.resolve();
  return Promise.race([syncing, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

// サーバーとユーザーデータ（設定・読書位置・お気に入りなど）を双方向同期する
export function syncWithServer(onSync = null) {
  const task = doSync(onSync).finally(() => {
    if (syncing === task) syncing = null;
  });
  syncing = task;
  return task;
}

async function doSync(onSync) {
  try {
    const remote = await fetchStore();
    if (!remote || typeof remote !== 'object') return;
    const localPatch = {};

    // 読書位置 (updatedAt が新しい方を採用)
    const localPositions = getPositions();
    const remotePositions = remote.positions || {};
    const mergedPositions = { ...localPositions };
    for (const [p, rPos] of Object.entries(remotePositions)) {
      const lPos = localPositions[p];
      if (!lPos || (rPos.updatedAt ?? 0) >= (lPos.updatedAt ?? 0)) {
        mergedPositions[p] = rPos;
      } else {
        localPatch.positions ??= {};
        localPatch.positions[p] = lPos;
      }
    }
    for (const [p, lPos] of Object.entries(localPositions)) {
      if (!(p in remotePositions)) {
        localPatch.positions ??= {};
        localPatch.positions[p] = lPos;
      }
    }
    positionsCache = mergedPositions;
    scheduleWritePositions();

    // お気に入り・後で読む
    for (const kind of ['favorite', 'later']) {
      const field = kind === 'favorite' ? 'favorites' : 'later';
      const localMarks = readMarks(kind);
      const remoteMarks = remote[field] || {};
      const mergedMarks = { ...localMarks, ...remoteMarks };
      for (const [p, at] of Object.entries(localMarks)) {
        if (!(p in remoteMarks)) {
          localPatch[field] ??= {};
          localPatch[field][p] = at;
        }
      }
      write(MARK_KEYS[kind], mergedMarks);
    }

    // ピン留め
    const localPins = getPins();
    const remotePins = remote.pins || {};
    const mergedPins = { ...localPins, ...remotePins };
    for (const [p, at] of Object.entries(localPins)) {
      if (!(p in remotePins)) {
        localPatch.pins ??= {};
        localPatch.pins[p] = at;
      }
    }
    write(KEY_PINS, mergedPins);

    // フォルダソート設定
    const localSort = read(KEY_FOLDER_SORT, {});
    const remoteSort = remote.folderSort || {};
    const mergedSort = { ...localSort, ...remoteSort };
    for (const [p, sortKey] of Object.entries(localSort)) {
      if (!(p in remoteSort)) {
        localPatch.folderSort ??= {};
        localPatch.folderSort[p] = sortKey;
      }
    }
    write(KEY_FOLDER_SORT, mergedSort);

    // 付箋（推敲メモ）
    const localNotes = getNotes();
    const remoteNotes = remote.notes || {};
    const mergedNotes = { ...localNotes };
    for (const [id, rNote] of Object.entries(remoteNotes)) {
      const lNote = localNotes[id];
      if (!lNote || (rNote.updatedAt ?? 0) >= (lNote.updatedAt ?? 0)) {
        mergedNotes[id] = rNote;
      } else {
        localPatch.notes ??= {};
        localPatch.notes[id] = lNote;
      }
    }
    for (const [id, lNote] of Object.entries(localNotes)) {
      if (!(id in remoteNotes)) {
        localPatch.notes ??= {};
        localPatch.notes[id] = lNote;
      }
    }
    write(KEY_NOTES, mergedNotes);

    // ローカルのみにあった差分をサーバーに送信
    if (Object.keys(localPatch).length) {
      schedulePush(localPatch);
    }

    if (onSync) onSync();
  } catch {
    // サーバーに繋がらない（オフライン等）ときはローカルデータをそのまま使用
  }
}

// 旧バージョンで IndexedDB に保存されていた本文・ハッシュのデータベースを端末から完全に削除する
if (typeof indexedDB !== 'undefined') {
  try {
    indexedDB.deleteDatabase('novelbook');
  } catch {}
}
