// 設定・読書位置・印・付箋などを localStorage に保存し、Mac 上のサーバーとも同期する。
// 表示設定と最後に開いていた画面は端末ごとのものなので、サーバーには送らない

import { fetchStore, saveStorePatch, fetchBaseline, fetchBaselineText } from './api.js';

// localStorage のキー（nb は以前の名前 novelbook の名残り）
const KEYS = {
  settings: 'nb.settings',
  route: 'nb.route',
  positions: 'nb.positions',
  favorites: 'nb.favorites',
  later: 'nb.later',
  pins: 'nb.pins',
  folderSort: 'nb.folderSort',
  notes: 'nb.notes',
  seriesIcons: 'nb.seriesIcons',
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

// サーバーへの送信
//
// 変更は { 種類: { キー: 値（null なら削除） } } の形で少し貯めてからまとめて送る。
// 送れなかったときは、間隔を延ばしながら送り直す

const PUSH_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 30000;
let pendingPatch = {};
let pushTimer = null;
let isPushing = false;
let pushRetryCount = 0;

function schedulePush(patch = {}, delay = PUSH_DELAY_MS) {
  for (const [field, entries] of Object.entries(patch)) {
    pendingPatch[field] = { ...pendingPatch[field], ...entries };
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flushPush, delay);
}

const hasPending = () => Object.keys(pendingPatch).length > 0;

async function flushPush() {
  clearTimeout(pushTimer);
  pushTimer = null;
  flushPositions();
  if (isPushing || !hasPending()) return;

  const payload = pendingPatch;
  pendingPatch = {};
  isPushing = true;
  try {
    await saveStorePatch(payload);
    pushRetryCount = 0;
  } catch {
    // 送れなかった分を戻して送り直す。その間に入った新しい変更のほうが優先される
    pendingPatch = mergePatches(payload, pendingPatch);
    const delay = Math.min(1000 * 2 ** pushRetryCount, MAX_RETRY_DELAY_MS);
    pushRetryCount++;
    schedulePush({}, delay);
  } finally {
    isPushing = false;
    // 送っている間に新しい変更が入っていたら、続けて送る
    if (hasPending() && !pushTimer) pushTimer = setTimeout(flushPush, PUSH_DELAY_MS);
  }
}

function mergePatches(older, newer) {
  const merged = { ...older };
  for (const [field, entries] of Object.entries(newer)) merged[field] = { ...merged[field], ...entries };
  return merged;
}

if (typeof window !== 'undefined') {
  // 離れるときは貯めている変更をすぐに送る
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPush();
  });
  window.addEventListener('pagehide', flushPush);
  window.addEventListener('online', () => {
    if (!hasPending()) return;
    pushRetryCount = 0;
    schedulePush({}, 100);
  });
}

// 表示設定

// 広い画面では、ページが横に広がりすぎて読みにくくならないよう左右の余白を大きくする
export const WIDE_QUERY = matchMedia('(min-width: 800px) and (min-height: 600px)');

const DEFAULT_SETTINGS = {
  fontSize: 18,
  lineHeight: 1.8,
  marginBlockEm: 1.5,
  marginInlineEm: WIDE_QUERY.matches ? 8 : 1,
  font: 'mincho',
  theme: 'light',
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) };
}

// 表示設定は画面サイズや端末ごとに異なるため、サーバー同期せず端末（localStorage）のみに保存する
export function saveSettings(settings) {
  write(KEYS.settings, settings);
}

// 読書位置。ファイルの相対パス → { line, off, snippet, page, pages, mtime, updatedAt }
//
// ページをめくるたびに変わるので、メモリに持っておき、localStorage へは少し待ってから書く

let positionsCache = null;
let writePositionsTimer = null;

export function getPositions() {
  positionsCache ??= read(KEYS.positions, {});
  return positionsCache;
}

function writePositionsNow() {
  clearTimeout(writePositionsTimer);
  writePositionsTimer = null;
  if (positionsCache) write(KEYS.positions, positionsCache);
}

function scheduleWritePositions() {
  writePositionsTimer ??= setTimeout(writePositionsNow, 300);
}

// 書き込み待ちの読書位置があれば、すぐに書く
function flushPositions() {
  if (writePositionsTimer) writePositionsNow();
}

export function getPosition(path) {
  return getPositions()[path] ?? null;
}

export function setPosition(path, pos) {
  const entry = { ...pos, updatedAt: Date.now() };
  getPositions()[path] = entry;
  scheduleWritePositions();
  schedulePush({ positions: { [path]: entry } });
  return entry;
}

export function deletePositions(paths) {
  const all = getPositions();
  const deleted = paths.filter((path) => path in all);
  if (!deleted.length) return;
  for (const path of deleted) delete all[path];
  scheduleWritePositions();
  schedulePush({ positions: Object.fromEntries(deleted.map((path) => [path, null])) });
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

// 印とピン留め。どちらもフォルダ・ファイルの相対パス → 付けた日時

// パス → 日時 の data で path の印を付け外しし、保存してサーバーにも送る。付けたら true を返す
function toggleStamp(field, data, path) {
  const on = !(path in data);
  if (on) data[path] = Date.now();
  else delete data[path];
  write(KEYS[field], data);
  schedulePush({ [field]: { [path]: on ? data[path] : null } });
  return on;
}

// お気に入り（favorite）と後で読む（later）の印。値はサーバーと localStorage での名前
const MARK_FIELDS = { favorite: 'favorites', later: 'later' };

function readMarks(kind) {
  const data = read(KEYS[MARK_FIELDS[kind]], {});
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
  return toggleStamp(MARK_FIELDS[kind], readMarks(kind), path);
}

// 印を付けた日時が新しい順
export function getMarked(kind) {
  return Object.entries(readMarks(kind))
    .map(([path, at]) => ({ path, at }))
    .sort((a, b) => b.at - a.at);
}

// ピン留めした項目は、各フォルダの一覧の上部に固定して出す
export function getPins() {
  return read(KEYS.pins, {});
}

export function isPinned(path) {
  return path in getPins();
}

export function togglePin(path) {
  return toggleStamp('pins', getPins(), path);
}

// フォルダごとの一覧の並び順。フォルダの相対パス → 'name-asc' | 'name-desc' | 'mtime-desc' | 'mtime-asc' | 'progress'

const readFolderSorts = () => read(KEYS.folderSort, {});

export function getFolderSort(folderPath) {
  return readFolderSorts()[folderPath] ?? 'name-asc';
}

export function setFolderSort(folderPath, sortKey) {
  write(KEYS.folderSort, { ...readFolderSorts(), [folderPath]: sortKey });
  schedulePush({ folderSort: { [folderPath]: sortKey } });
}

// 付箋（推敲メモ）。付箋の ID → { id, path, line, off, snippet, text, createdAt, updatedAt }

const readNotes = () => read(KEYS.notes, {});

// その話の付箋を、本文の順に
export function getNotesForPath(path) {
  return Object.values(readNotes())
    .filter((n) => n.path === path)
    .sort((a, b) => a.line - b.line || (a.off ?? 0) - (b.off ?? 0));
}

// id がなければ新しい付箋を作る。off と snippet を省いたときは、前の値のままにする
export function saveNote({ id, path, line, off, snippet, text }) {
  const notes = readNotes();
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
  write(KEYS.notes, notes);
  schedulePush({ notes: { [noteId]: note } });
  return note;
}

export function deleteNote(id) {
  const notes = readNotes();
  delete notes[id];
  write(KEYS.notes, notes);
  schedulePush({ notes: { [id]: null } });
}

// アイコンのあるシリーズ（名前 → サーバーが返すフォルダのアイコンの情報）。
// 印の一覧などサーバーに聞かずに描く画面でも使えるよう覚えておく
export function getSeriesIcons() {
  const data = read(KEYS.seriesIcons, {});
  // 以前は画像を置いたシリーズの名前の配列だった
  return Array.isArray(data) ? Object.fromEntries(data.map((name) => [name, { file: true }])) : data;
}

export function setSeriesIcons(icons) {
  if (icons && typeof icons === 'object') write(KEYS.seriesIcons, icons);
}

// 最後に開いていた画面（URL のハッシュ）

export function getLastRoute() {
  return localStorage.getItem(KEYS.route);
}

export function setLastRoute(route) {
  localStorage.setItem(KEYS.route, route);
}

// 変更箇所の印の基準にする、前回の本文の行ごとの指紋（ハッシュ値）と本文の全文。
// 大きいので端末には保存せず、サーバーから取ってくる

export async function getBaseline(path) {
  return await fetchBaseline(path);
}

export function setBaseline(path, hashes) {
  schedulePush({ baselines: { [path]: hashes } });
}

export async function getBaselineText(path) {
  return await fetchBaselineText(path);
}

export function setBaselineText(path, text) {
  schedulePush({ baselineTexts: { [path]: text } });
}

// サーバーとの同期

// 同期の最中なら、その完了を待つ Promise（長くかかるときは待たずに進む）。
// 開いた話の読書位置を決める前に、他の端末の位置を取り込んでおくために使う
let syncing = null;
export function syncSettled(timeoutMs = 2000) {
  if (!syncing) return Promise.resolve();
  return Promise.race([syncing, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

// サーバーとユーザーデータ（読書位置・印・付箋など）を双方向に同期し、取り込んだら onSync を呼ぶ
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
    mergeRemote(remote);
    onSync?.();
  } catch {
    // サーバーにつながらない（オフラインなど）ときは、端末のデータをそのまま使う
  }
}

// サーバーのデータを端末に取り込む。端末にしかない（または端末のほうが新しい）項目は、サーバーへ送る
function mergeRemote(remote) {
  const toPush = {};
  const merge = (field, local, mergeFn) => {
    const { merged, localOnly } = mergeFn(local, remote[field] || {});
    if (Object.keys(localOnly).length) toPush[field] = localOnly;
    return merged;
  };

  positionsCache = merge('positions', getPositions(), mergeByUpdatedAt);
  scheduleWritePositions();
  for (const [kind, field] of Object.entries(MARK_FIELDS)) {
    write(KEYS[field], merge(field, readMarks(kind), mergePreferRemote));
  }
  write(KEYS.pins, merge('pins', getPins(), mergePreferRemote));
  write(KEYS.folderSort, merge('folderSort', readFolderSorts(), mergePreferRemote));
  write(KEYS.notes, merge('notes', readNotes(), mergeByUpdatedAt));

  if (Object.keys(toPush).length) schedulePush(toPush);
}

// 両方にある項目は updatedAt が新しいほうを採る（同じならサーバーのほう）
function mergeByUpdatedAt(local, remote) {
  const merged = { ...local };
  const localOnly = {};
  for (const [key, r] of Object.entries(remote)) {
    const l = local[key];
    if (!l || (r.updatedAt ?? 0) >= (l.updatedAt ?? 0)) merged[key] = r;
    else localOnly[key] = l;
  }
  for (const [key, l] of Object.entries(local)) {
    if (!(key in remote)) localOnly[key] = l;
  }
  return { merged, localOnly };
}

// 両方にある項目はサーバーのほうを採る
function mergePreferRemote(local, remote) {
  const localOnly = Object.fromEntries(Object.entries(local).filter(([key]) => !(key in remote)));
  return { merged: { ...local, ...remote }, localOnly };
}
