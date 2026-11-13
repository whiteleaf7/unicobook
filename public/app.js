import { Reader, BASELINE_MISSING } from './reader.js';
import { openViewer, closeViewer, isViewerOpen } from './viewer.js';
import {
  fetchList,
  fetchRecentlyUpdated,
  fetchTexts,
  searchAll,
  dirname,
  basename,
  largeImageUrl,
  iconUrl,
  saveIconSetting,
  generateIcon,
  fetchSummary,
  generateSummary,
} from './api.js';
import { PRESET_GROUPS, hasPreset, presetIcon } from './presets.js';
import { diffChars } from './diff.js';
import { $, h } from './dom.js';
import { attachLongPress } from './long-press.js';
import { renderMarkdown } from './markdown.js';
import * as store from './store.js';

const filerEl = $('#filer');
const readerEl = $('#reader');
const menuEl = $('#menu');
const sheetEl = $('#sheet');
const toastEl = $('#toast');
const dialogEl = $('#dialog');
const slider = $('.slider', menuEl);
const listEl = $('.list', filerEl);

let settings = store.loadSettings();
// リーダーで開いているファイル。ファイラーを出している間は null
let currentFile = null;

// めくって前後の話へ移ったときに、次に開く話をどこから見せるか（'first' か 'last'）
let pendingInitialPage = null;

const reader = new Reader(readerEl, {
  onTap: handleTap,
  onChange: updatePageInfo,
  canDrag: () => menuEl.hidden && sheetEl.hidden,
  onImageOpen: (src) => openViewer(src, largeImageUrl(src)),
  onNavigateEpisode: (direction, ep) => {
    if (!ep) return;
    pendingInitialPage = direction === 'prev' ? 'last' : 'first';
    location.hash = ep.href;
  },
  onDiffDetail: (hunk, hunks, index) => openDiffSheet(hunk, hunks, index),
  onNoteOpen: (line, noteId) => openNotesSheet(line, noteId),
});
// ブラウザの開発者ツールから確かめるための入口
window.__openDiffSheet = openDiffSheet;
window.__reader = reader;

// iOS Safari は画面の端から払うとブラウザの戻る・進むになり、ページをめくるつもりが前の画面に戻ってしまう。
// 本文と挿絵では端で触れ始めたときの既定の動きを止める。ページめくりは pointer イベントで受けるので止まらない。
// リンクやボタンは click が要るので止めない
const EDGE_WIDTH = 32;
document.addEventListener(
  'touchstart',
  (e) => {
    const x = e.touches[0].clientX;
    if (x > EDGE_WIDTH && x < window.innerWidth - EDGE_WIDTH) return;
    if (!e.target.closest('#reader, #viewer') || e.target.closest('a, button')) return;
    e.preventDefault();
  },
  { passive: false },
);

const dirRoute = (path) => `#/d/${encodeURIComponent(path)}`;
const fileRoute = (path) => `#/r/${encodeURIComponent(path)}`;
const childPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const displayName = (path) => basename(path).replace(/\.txt$/i, '');
const sortByName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
const sortedFiles = (list) => [...list.files].sort(sortByName);
const RECENT_COUNT = 5;
const UPDATED_COUNT = 100;
const UPDATED_ROUTE = '#/updated';
const HISTORY_COUNT = 100;
const HISTORY_ROUTE = '#/history';
// series を渡すと、そのシリーズ（小説フォルダ直下のフォルダ）の中だけを探す
const searchRoute = (query, series = null) => {
  const base = series ? `#/search-in/${encodeURIComponent(series)}` : '#/search';
  return query ? `${base}/${encodeURIComponent(query)}` : base;
};

const ICONS = {
  dir: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.7l2 2.3h8.3A1.5 1.5 0 0 1 21 8.8v9.7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3h7.5l4.5 4.5V21h-12z"/><path d="M14 3v4.5h4.5M9 12h6M9 15h6M9 18h4"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6l.8.8.8-.8v-6H18v-2l-2-2z"/></svg>',
  sort: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M6 12h12m-9 6h6"/></svg>',
  heart:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10v17L12 16.8 7 20.5z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
};

// フォルダ・ファイルに付ける印。後で読む（栞）・お気に入り（ハート）の順に並べる
const MARKS = {
  later: { label: '後で読む', icon: 'bookmark' },
  favorite: { label: 'お気に入り', icon: 'heart' },
};
const markedRoute = (kind) => `#/m/${kind}`;
const APP_NAME = 'ユニコブック';

const HOME_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7M6 9v10.5h4.5V14h3v5.5H18V9" /></svg>';
const UNICO_ICON_HTML = `<img class="unico-icon" src="icons/icon-192.png" alt="${APP_NAME}" />`;

function updateHomeButton(isTop) {
  const btn = $('.home', filerEl);
  if (!btn) return;
  btn.classList.toggle('is-top', isTop);
  btn.setAttribute('aria-label', isTop ? APP_NAME : 'トップのフォルダへ');
  btn.innerHTML = isTop ? UNICO_ICON_HTML : HOME_SVG;
}

function icon(kind) {
  const span = h('span', { class: `icon ${kind}` });
  span.innerHTML = ICONS[kind];
  return span;
}

// フォルダのアイコン。info はサーバーが返す { file: 画像のファイル名, version, preset: ID, preferPreset: true }（どれも省略可）。
// フォルダに置いた画像は、preferPreset でなければプリセットより優先する。
// 画像が読み込めないときや、アイコンがないときは fallback のアイコンにする
function folderIcon(dirPath, info, fallback) {
  if (info?.file && !info.preferPreset) return fileIcon(dirPath, info.version, fallback);
  if (info?.preset && hasPreset(info.preset)) return presetIcon(info.preset);
  return icon(fallback);
}

function fileIcon(dirPath, version, fallback) {
  const img = h('img', { src: iconUrl(dirPath, version), alt: '', loading: 'lazy' });
  const span = h('span', { class: 'icon thumb' }, img);
  img.addEventListener('error', () => span.replaceWith(icon(fallback)), { once: true });
  return span;
}

// 続きを読む・各一覧の行では、作品の入っているシリーズのアイコンを出す
function seriesIcon(path, fallback) {
  const series = path.split('/')[0];
  return folderIcon(series, store.getSeriesIcons()[series], fallback);
}

// 作品の行に出すシリーズのアイコン。フォルダの行と見分けられるよう、右下にファイルの印を重ねる
function seriesFileIcon(filePath) {
  const el = seriesIcon(filePath, 'file');
  if (el.classList.contains('file')) return el;
  return h('span', { class: 'icon-badged' }, el, icon('file'));
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2500);
}

// サーバーにつながらず、Service Worker が保存しておいたもの（what）を返したときに知らせる
function toastIfCached(data, what) {
  if (data?.fromCache) toast(`つながらないため、保存済みの${what}を表示しています`);
}

// ステータスバーの色も背景色に合わせる
function applyTheme() {
  if (settings.theme === 'auto') settings.theme = 'light';
  document.documentElement.dataset.theme = settings.theme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').content = bg;
}

const isFinished = (pos) => Boolean(pos?.pages) && pos.page >= pos.pages - 1;

// 最後に読んだあとにファイルが更新されたか。まだ読んでいない話は数えない
const updatedSinceRead = (path, mtime) => {
  const pos = store.getPosition(path);
  return Boolean(pos?.mtime && mtime > pos.mtime);
};

// 更新日時を知らずに描いた行（data-check-updated にパスを持つ）に、あとからサーバーに更新日時を聞いて更新の印を付ける。
// つながらないときは印を付けずにおく
async function markUpdatedLater(container) {
  const rows = [...container.querySelectorAll('.row[data-check-updated]')];
  if (!rows.length) return;
  let texts;
  try {
    texts = await fetchTexts([...new Set(rows.map((row) => row.dataset.checkUpdated))]);
  } catch {
    return;
  }
  for (const row of rows) {
    if (texts[row.dataset.checkUpdated]?.some((t) => updatedSinceRead(t.path, t.mtime))) row.classList.add('updated');
  }
}

function progressText(pos) {
  if (!pos || !pos.pages) return '';
  return `${Math.floor(((pos.page + 1) / pos.pages) * 100)}%`;
}

// ルーティング

// URL のハッシュを、開く画面にする。リーダーなら { type: 'reader', path }、それ以外は一覧の画面（view）
function parseRoute(hash) {
  const decoded = (m, i) => decodeURIComponent(m?.[i] ?? '');
  if (hash === UPDATED_ROUTE) return { type: 'updated' };
  if (hash === HISTORY_ROUTE) return { type: 'history' };
  const file = hash.match(/^#\/r\/(.*)$/);
  if (file) return { type: 'reader', path: decoded(file, 1) };
  const seriesSearch = hash.match(/^#\/search-in\/([^/]+)(?:\/(.*))?$/);
  if (seriesSearch) return { type: 'search', query: decoded(seriesSearch, 2), series: decoded(seriesSearch, 1) };
  if (hash.startsWith('#/search')) return { type: 'search', query: decoded(hash.match(/^#\/search\/(.*)$/), 1), series: null };
  const marked = hash.match(/^#\/m\/(\w+)$/);
  if (marked && MARKS[marked[1]]) return { type: 'marked', kind: marked[1] };
  return { type: 'folder', path: decoded(hash.match(/^#\/d\/(.*)$/), 1) };
}

function route() {
  const hash = location.hash || dirRoute('');
  store.setLastRoute(hash);
  const target = parseRoute(hash);
  if (target.type === 'reader') void openReader(target.path);
  else void openView(target);
}

// ファイラー

// ファイラーに出している一覧。リーダーを開いている間は null。
// - { type: 'folder', path }: フォルダの中身（path が '' ならトップ）
// - { type: 'marked', kind }: 印の一覧
// - { type: 'history' }: 開いた履歴
// - { type: 'updated' }: 最近の更新
// - { type: 'search', query, series }: 検索（series はシリーズの中だけを探すときのシリーズ名）
// 読み込みを待つ間に別の一覧へ移ったかは、view が同じオブジェクトのままかで確かめる
let view = null;

function openView(v) {
  switch (v.type) {
    case 'marked':
      return openMarked(v.kind);
    case 'history':
      return openHistory();
    case 'updated':
      return openUpdated();
    case 'search':
      return openSearch(v.query, v.series);
    default:
      return openFiler(v.path);
  }
}

// 今の一覧を、スクロール位置を保ったまま読み直す
function refreshFiler() {
  void openView(view ?? { type: 'folder', path: '' });
}

// 一覧ごとのスクロール位置（リーダーから戻ったときや読み直したときに、元の場所を表示するため）
const scrollPositions = new Map();

function scrollKey(v) {
  if (v.type === 'folder') return v.path;
  if (v.type === 'marked') return `@${v.kind}`;
  if (v.type === 'search') return `@search:${v.series ?? ''}:${v.query}`;
  return `@${v.type}`;
}

function rememberScroll() {
  if (view) scrollPositions.set(scrollKey(view), window.scrollY);
}

function restoreScroll() {
  window.scrollTo(0, scrollPositions.get(scrollKey(view)) ?? 0);
}

// リーダーなどを閉じて、ファイラーに newView の一覧を出す準備をする。
// crumbs を渡せばパンくずも描く（フォルダの一覧は中身を読み込んでから描く）
function showFiler(newView, { title, crumbs = null }) {
  hideMenu();
  closeSheet();
  closeViewer();
  if (currentFile) {
    reader.close();
    currentFile = null;
  }
  readerEl.hidden = true;
  filerEl.hidden = false;
  rememberScroll();
  view = newView;
  const isFolder = newView.type === 'folder';
  // 並び順はフォルダごとに覚えるので、フォルダの一覧でだけ変えられる
  $('.sort', filerEl).disabled = !isFolder;
  // あらすじはシリーズのフォルダの中でだけ出す
  $('.summary', filerEl).hidden = !(isFolder && newView.path);
  updateHomeButton(isFolder && !newView.path);
  document.title = title;
  if (crumbs) setCrumbs(crumbs);
}

function setCrumbs(crumbs) {
  $('.crumbs', filerEl).replaceChildren(
    ...crumbs.flatMap((c, i) => {
      const last = i === crumbs.length - 1;
      const node = last ? h('span', { class: 'current' }, c.name) : h('a', { href: c.href }, c.name);
      return i === 0 ? [node] : [h('span', { class: 'sep' }, '/'), node];
    }),
  );
}

// 一覧の行を出し、更新の印を付け、前に見ていたスクロール位置に戻す
function showRows(rows) {
  listEl.replaceChildren(...rows);
  void markUpdatedLater(listEl);
  restoreScroll();
}

const upRow = (href) => h('div', { class: 'row up' }, h('a', { class: 'main', href }, icon('up'), h('span', { class: 'name' }, '..')));

const emptyRow = (...message) => h('p', { class: 'empty' }, ...message);

const loadFailedRow = (e, message = '読み込めませんでした') => emptyRow(message, h('br'), e.message);

async function openFiler(path) {
  const thisView = { type: 'folder', path };
  showFiler(thisView, { title: path ? basename(path) : APP_NAME });
  try {
    const data = await fetchList(path);
    store.setSeriesIcons(data.seriesIcons);
    if (view !== thisView) return;
    renderFiler(data);
    toastIfCached(data, '一覧');
  } catch (e) {
    if (view !== thisView) return;
    $('.crumbs', filerEl).replaceChildren(path || APP_NAME);
    listEl.replaceChildren(loadFailedRow(e));
  }
}

function renderFiler(data) {
  const { path } = data;
  const segments = path ? path.split('/') : [];
  const crumbs = path ? segments.map((name, i) => ({ name, href: dirRoute(segments.slice(0, i + 1).join('/')) })) : [{ name: APP_NAME, href: dirRoute('') }];
  setCrumbs(crumbs);

  const rows = path ? [upRow(dirRoute(dirname(path)))] : topSections(data);
  rows.push(...folderRows(data));
  if (!data.dirs.length && !data.files.length) rows.push(emptyRow('このフォルダには表示できるファイルがありません'));
  showRows(rows);
}

// トップの一覧の上に出す、続きを読む・各一覧への入口・「一覧」の見出し
function topSections(data) {
  const existingPaths = new Set([
    ...data.files.map((f) => f.name),
    ...data.dirs.flatMap((d) => (d.texts ?? []).map((t) => (typeof t === 'string' ? t : t.path))),
  ]);

  // キャッシュからの表示でなければ、存在しないファイルの読書位置を削除する
  if (!data.fromCache) {
    const missing = Object.keys(store.getPositions()).filter((p) => !existingPaths.has(p));
    if (missing.length) store.deletePositions(missing);
  }

  const rows = [];
  // 削除されたファイルを除き、1 件多く取り、続きがあれば履歴の一覧への入口を出す
  const recent = store
    .getRecent()
    .filter((r) => existingPaths.has(r.path))
    .slice(0, RECENT_COUNT + 1);
  if (recent.length) {
    rows.push(
      h(
        'div',
        { class: 'section-head' },
        h('h2', { class: 'section-label' }, '続きを読む'),
        recent.length > RECENT_COUNT ? h('a', { class: 'more', href: HISTORY_ROUTE }, 'もっと表示') : null,
      ),
    );
    // どの作品かわかるよう、シリーズ名（小説フォルダ直下のフォルダ名）を添える
    rows.push(...recent.slice(0, RECENT_COUNT).map((r) => fileRow(r.path, { label: seriesOf(r.path), recent: true, withSeriesIcon: true })));
  }
  // 後で読む・お気に入り・最近の更新の一覧への入口は、縦幅を取らないよう 1 行に並べる
  const shortcut = (href, iconName, label, count) =>
    h(
      'a',
      { class: 'shortcut', href },
      icon(iconName),
      h('span', { class: 'label' }, label),
      count == null ? null : h('span', { class: 'count' }, String(count)),
    );
  rows.push(
    h(
      'nav',
      { class: 'shortcuts' },
      Object.entries(MARKS).map(([kind, { label, icon: iconName }]) => shortcut(markedRoute(kind), iconName, label, store.getMarked(kind).length)),
      shortcut(UPDATED_ROUTE, 'clock', '最近の更新'),
    ),
  );
  rows.push(h('h2', { class: 'section-label' }, '一覧'));
  return rows;
}

// フォルダの中のフォルダとファイルの行。ピン留めしたものを上に、それぞれフォルダ・ファイルの順に並べる
function folderRows(data) {
  const { path } = data;
  const compare = folderItemComparator(store.getFolderSort(path ?? ''));
  const pins = store.getPins();
  const items = [
    ...data.dirs.map((d) => {
      const p = childPath(path, d.name);
      const mtime = d.texts?.length ? Math.max(...d.texts.map((t) => t.mtime ?? 0)) : 0;
      return { name: d.name, path: p, mtime, isDir: true, info: d };
    }),
    ...data.files.map((f) => ({ name: f.name, path: childPath(path, f.name), mtime: f.mtime, isDir: false, info: f })),
  ];
  const rowOf = (item, pinned) =>
    item.isDir ? dirRow(item.path, { iconInfo: item.info.icon, texts: item.info.texts, pinned }) : fileRow(item.path, { mtime: item.info.mtime, pinned });
  const sorted = (list) => [...list].sort(compare);
  return [true, false].flatMap((pinned) => {
    const group = items.filter((item) => item.path in pins === pinned);
    const dirs = sorted(group.filter((item) => item.isDir));
    const files = sorted(group.filter((item) => !item.isDir));
    return [...dirs, ...files].map((item) => rowOf(item, pinned));
  });
}

// 一覧の並び順（store.getFolderSort の値）で、2 つの項目 { name, path, mtime } を比べる関数
function folderItemComparator(sortMode) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
  const finished = (item) => (isFinished(store.getPosition(item.path)) ? 1 : 0);
  switch (sortMode) {
    case 'name-desc':
      return (a, b) => byName(b, a);
    case 'mtime-desc':
      return (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || byName(a, b);
    case 'mtime-asc':
      return (a, b) => (a.mtime ?? 0) - (b.mtime ?? 0) || byName(a, b);
    // 読み終えていないものを先に
    case 'progress':
      return (a, b) => finished(a) - finished(b) || byName(a, b);
    default:
      return byName;
  }
}

// シリーズ名は小説フォルダ直下のフォルダ名。直下のファイルにはない
const seriesOf = (path) => (path.includes('/') ? path.split('/')[0] : null);

// フォルダを横断する一覧で、どこにあるかを示すラベル（「シリーズ / 章」）。小説フォルダ直下なら null
const folderLabel = (path) => (path.includes('/') ? dirname(path).split('/').join(' / ') : null);

// 履歴・最近の更新の行のラベル。シリーズ名と日付
const seriesAndDate = (path, time) => [seriesOf(path), shortDate(time)].filter(Boolean).join('　');

// 「MM/DD」。今年でなければ「YY/MM/DD」
function shortDate(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return d.getFullYear() < new Date().getFullYear() ? `${pad(d.getFullYear() % 100)}/${md}` : md;
}

// label はタイトルの上に小さく出す、どこにある作品かの説明（シリーズ名や親フォルダ）
function nameWithLabel(name, label) {
  return h('span', { class: 'name' }, label ? h('span', { class: 'label' }, label) : null, name);
}

// フォルダの行。アイコンをタップするとアイコンを選べる。iconInfo はこのフォルダ自身のアイコンで、
// withSeriesIcon のときは表示だけシリーズのアイコンにする（フォルダを横断する一覧用）
// texts はフォルダの下（サブフォルダも含む）のテキストファイル（{ path, mtime }）で、「読了数/話数」と更新の印を出すのに使う。
// texts がない（または mtime を持たない）ときは、更新の印だけをあとから付ける
function dirRow(dirPath, { label = null, iconInfo = null, withSeriesIcon = false, texts = null, pinned = false } = {}) {
  const iconEl = withSeriesIcon ? seriesIcon(dirPath, 'dir') : folderIcon(dirPath, iconInfo, 'dir');
  const textPath = (t) => (typeof t === 'string' ? t : t?.path);
  const progress = texts?.length ? `${texts.filter((t) => isFinished(store.getPosition(textPath(t)))).length}/${texts.length}話` : null;
  const hasMtimes = Boolean(texts?.length && texts.every((t) => typeof t === 'object' && t && typeof t.mtime === 'number'));
  const updated = Boolean(hasMtimes && texts.some((t) => updatedSinceRead(t.path, t.mtime)));
  const iconButton = h(
    'button',
    { class: 'icon-button', 'aria-label': `「${basename(dirPath)}」のアイコンを変える`, onclick: () => openIconPicker(dirPath, iconInfo) },
    iconEl,
  );
  const link = h(
    'a',
    { class: 'main', href: dirRoute(dirPath) },
    nameWithLabel(basename(dirPath), label),
    // 更新の印をこの左に付けるので、読了数がなくても置いておく
    h('span', { class: 'meta' }, progress ? h('span', { class: 'count' }, progress) : null),
  );
  return h(
    'div',
    { class: `row dir${pinned ? ' pinned' : ''}${updated ? ' updated' : ''}`, 'data-check-updated': hasMtimes ? null : dirPath },
    iconButton,
    link,
    pinButton(dirPath),
    ...markButtons(dirPath),
  );
}

function openIconPicker(dirPath, iconInfo) {
  const choose = async (preset) => {
    try {
      await saveIconSetting(dirPath, { preset });
      closeSheet();
      refreshFiler();
    } catch (e) {
      toast(`保存できませんでした: ${e.message}`);
    }
  };
  const current = iconInfo?.preset ?? null;
  openSheet(
    h('h2', {}, `「${basename(dirPath)}」のアイコン`),
    iconInfo?.file ? iconFileSetting(dirPath, iconInfo) : null,
    iconGenerator(dirPath, iconInfo),
    h(
      'div',
      { class: 'preset-grid' },
      h('button', { class: `preset-choice none${current === null ? ' selected' : ''}`, 'aria-label': 'なし', onclick: () => choose(null) }, icon('dir')),
    ),
    PRESET_GROUPS.map((group) => [
      h('h3', { class: 'preset-group' }, group.label),
      h(
        'div',
        { class: 'preset-grid' },
        group.presets.map((p) =>
          h(
            'button',
            { class: `preset-choice${current === p.id ? ' selected' : ''}`, 'aria-label': p.text ?? p.id, onclick: () => choose(p.id) },
            presetIcon(p.id),
          ),
        ),
      ),
    ]),
  );
}

// フォルダに画像を置いているときに、その画像と、画像より下のアイコンを優先するかのチェックボックスを出す
function iconFileSetting(dirPath, iconInfo) {
  const note = h('p', { class: 'sheet-note' });
  const showNote = (preferPreset) =>
    (note.textContent = preferPreset ? '下で選んだアイコンを表示しています' : 'フォルダの画像を表示しています（下で選んだアイコンより優先）');
  const checkbox = h('input', { type: 'checkbox' });
  checkbox.checked = !!iconInfo.preferPreset;
  checkbox.addEventListener('change', async () => {
    const preferPreset = checkbox.checked;
    try {
      await saveIconSetting(dirPath, { preferPreset });
      showNote(preferPreset);
      refreshFiler();
    } catch (e) {
      checkbox.checked = !preferPreset;
      toast(`保存できませんでした: ${e.message}`);
    }
  });
  showNote(checkbox.checked);
  return [
    h('div', { class: 'icon-file' }, fileIcon(dirPath, iconInfo.version, 'dir'), h('span', { class: 'icon-file-name' }, `フォルダの画像（${iconInfo.file}）`)),
    h('label', { class: 'icon-file-option' }, checkbox, '画像より下で選んだアイコンを優先する'),
    note,
  ];
}

// Gemini にフォルダ名（と追加の指示）からアイコンを作ってもらい、フォルダの icon.png にする。
// 作るのは Mac 側で、できあがるまではフォルダに「仮」のアイコンが置かれる
function iconGenerator(dirPath, iconInfo) {
  const hintInput = h('input', { type: 'text', placeholder: '追加の指示（例: 青系で、剣のモチーフ）', enterkeyhint: 'go' });
  const generateButton = h('button', { type: 'submit', class: 'text' }, '作る');
  generateButton.disabled = !!iconInfo?.generating;
  const generate = async () => {
    if (iconInfo?.file && !confirm(`フォルダの ${iconInfo.file} を置き換えます（前の画像は Mac 側に残します）`)) return;
    try {
      await generateIcon(dirPath, hintInput.value);
      closeSheet();
      refreshFiler();
      toast('アイコンを作っています。2〜3 分でできあがります');
    } catch (e) {
      toast(`作れませんでした: ${e.message}`);
    }
  };
  const note = iconInfo?.generating
    ? '作成中です。できあがるまで「仮」のアイコンを表示します'
    : iconInfo?.generateError
      ? `前回は作れませんでした: ${iconInfo.generateError}`
      : null;
  return [
    h('h3', { class: 'preset-group' }, 'Gemini で作る'),
    h(
      'form',
      {
        class: 'icon-generator',
        onsubmit: (e) => {
          e.preventDefault();
          if (!generateButton.disabled) void generate();
        },
      },
      hintInput,
      generateButton,
    ),
    note ? h('p', { class: 'sheet-note' }, note) : null,
  ];
}

// recent は「続きを読む」の行で、縦幅を節約して表示する。
// withSeriesIcon はフォルダを横断する一覧の行で、ファイルのアイコンの代わりにシリーズのアイコンを出す。
// mtime（ファイルの更新日時）がわかる一覧では、最後に読んだあとに更新があれば印を付ける。わからないときはあとから付ける
function fileRow(filePath, { label = null, recent = false, withSeriesIcon = false, mtime = null, pinned = false } = {}) {
  const pos = store.getPosition(filePath);
  const updated = mtime != null && updatedSinceRead(filePath, mtime);
  return h(
    'div',
    {
      class: `row file${recent ? ' recent' : ''}${pinned ? ' pinned' : ''}${updated ? ' updated' : ''}`,
      'data-check-updated': mtime == null ? filePath : null,
    },
    h(
      'a',
      { class: 'main', href: fileRoute(filePath) },
      withSeriesIcon && filePath.includes('/') ? seriesFileIcon(filePath) : icon('file'),
      nameWithLabel(displayName(filePath), label),
      h('span', { class: 'meta' }, h('span', { class: 'pct' }, progressText(pos))),
    ),
    recent ? null : pinButton(filePath),
    ...markButtons(filePath),
  );
}

function pinButton(path) {
  const pinned = store.isPinned(path);
  const button = h('button', {
    class: 'mark pin',
    'aria-label': pinned ? 'ピン留めを解除' : '上部にピン留め',
    'aria-pressed': String(pinned),
    onclick: (e) => {
      e.stopPropagation();
      store.togglePin(path);
      refreshFiler();
    },
  });
  button.innerHTML = ICONS.pin;
  return button;
}

// オン・オフは同じアイコンの塗りつぶしの有無で表す
function markButtons(path) {
  return Object.entries(MARKS).map(([kind, { label, icon: iconName }]) => {
    const button = h('button', {
      class: `mark ${kind}`,
      'aria-label': label,
      'aria-pressed': String(store.isMarked(kind, path)),
      onclick: () => button.setAttribute('aria-pressed', String(store.toggleMark(kind, path))),
    });
    button.innerHTML = ICONS[iconName];
    return button;
  });
}

// 印の一覧。フォルダに関係なく、印を付けた日時が新しい順に並べる。
// 一覧の中で印を外しても、押し間違えたときに戻せるよう、開き直すまでは消さない
function openMarked(kind) {
  const { label } = MARKS[kind];
  showFiler({ type: 'marked', kind }, { title: label, crumbs: [{ name: label }] });
  const items = store.getMarked(kind);
  const rows = [upRow(dirRoute(''))];
  for (const { path } of items) {
    const label = folderLabel(path);
    rows.push(
      path.toLowerCase().endsWith('.txt')
        ? fileRow(path, { label, withSeriesIcon: true })
        : dirRow(path, { label, iconInfo: path.includes('/') ? null : store.getSeriesIcons()[path], withSeriesIcon: true }),
    );
  }
  if (!items.length) rows.push(emptyRow(`${label}はまだありません`));
  showRows(rows);
}

// 開いた履歴。最後に開いた順に最大 HISTORY_COUNT 件で、開いた日も添える
function openHistory() {
  showFiler({ type: 'history' }, { title: '履歴', crumbs: [{ name: '履歴' }] });
  const recent = store.getRecent(HISTORY_COUNT);
  const rows = [upRow(dirRoute(''))];
  for (const { path, pos } of recent) {
    rows.push(fileRow(path, { label: seriesAndDate(path, pos.updatedAt), withSeriesIcon: true }));
  }
  if (!recent.length) rows.push(emptyRow('まだ何も開いていません'));
  showRows(rows);
}

// フォルダを横断して、更新日時が新しい順に最大 UPDATED_COUNT 件。並び順の根拠がわかるよう更新日も添える
async function openUpdated() {
  const thisView = { type: 'updated' };
  showFiler(thisView, { title: '最近の更新', crumbs: [{ name: '最近の更新' }] });
  try {
    const data = await fetchRecentlyUpdated(UPDATED_COUNT);
    store.setSeriesIcons(data.seriesIcons);
    if (view !== thisView) return;
    const rows = [upRow(dirRoute(''))];
    for (const f of data.files) {
      rows.push(fileRow(f.path, { label: seriesAndDate(f.path, f.mtime), withSeriesIcon: true, mtime: f.mtime }));
    }
    if (!data.files.length) rows.push(emptyRow('テキストファイルがありません'));
    showRows(rows);
    toastIfCached(data, '一覧');
  } catch (e) {
    if (view !== thisView) return;
    listEl.replaceChildren(upRow(dirRoute('')), loadFailedRow(e));
  }
}

// 小説フォルダ全体（series を渡したときはそのシリーズの中）からの検索。結果を押すと、その行のページを開いて見つかった言葉に印を付ける
let pendingJump = null;

async function openSearch(query, series = null) {
  const thisView = { type: 'search', query, series };
  const crumbs = [series ? { name: series, href: dirRoute(series) } : null, { name: '検索' }].filter(Boolean);
  showFiler(thisView, { title: query ? `検索: ${query}` : '検索', crumbs });
  const input = h('input', {
    type: 'search',
    enterkeyhint: 'search',
    placeholder: series ? 'このシリーズから検索' : 'すべての作品から検索',
    'aria-label': '検索する言葉',
  });
  input.value = query;
  const form = h(
    'form',
    {
      class: 'search-form',
      onsubmit: (e) => {
        e.preventDefault();
        input.blur();
        if (input.value.trim()) location.hash = searchRoute(input.value.trim(), series);
      },
    },
    withClearButton(input),
  );
  const results = h('div', { class: 'search-results' });
  listEl.replaceChildren(form, results);
  if (!query) {
    input.focus();
    return;
  }
  results.replaceChildren(emptyRow('検索しています…'));
  try {
    const data = await searchAll(query, series);
    store.setSeriesIcons(data.seriesIcons);
    if (view !== thisView) return;
    results.replaceChildren(...renderSearchResults(data, query));
    void markUpdatedLater(results);
    restoreScroll();
    toastIfCached(data, '結果');
  } catch (e) {
    if (view !== thisView) return;
    results.replaceChildren(loadFailedRow(e, '検索できませんでした'));
  }
}

// 検索欄の右に、入力を消す × ボタンを付ける。消したあとも続けて打てるよう、キーボードは閉じない
function withClearButton(input) {
  const button = h('button', {
    type: 'button',
    class: 'clear',
    'aria-label': '入力を消す',
    onpointerdown: (e) => e.preventDefault(),
    onclick: () => {
      input.value = '';
      button.hidden = true;
      input.focus();
    },
  });
  button.innerHTML =
    '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="currentColor"/><path d="M6.5 6.5l7 7m0-7-7 7" stroke="var(--bg)" stroke-width="1.8" stroke-linecap="round"/></svg>';
  button.hidden = !input.value;
  input.addEventListener('input', () => (button.hidden = !input.value));
  return h('div', { class: 'search-field' }, input, button);
}

function snippetEl(snippet, at, length) {
  return h('span', { class: 'snippet' }, snippet.slice(0, at), h('mark', {}, snippet.slice(at, at + length)), snippet.slice(at + length));
}

function renderSearchResults(data, query) {
  if (!data.results.length) return [h('p', { class: 'empty' }, `「${query}」は見つかりませんでした`)];
  const rows = [];
  let current = null;
  for (const r of data.results) {
    if (r.path !== current) {
      current = r.path;
      rows.push(fileRow(r.path, { label: folderLabel(r.path), withSeriesIcon: true }));
    }
    rows.push(
      h(
        'a',
        { class: 'search-hit', href: fileRoute(r.path), onclick: () => (pendingJump = { path: r.path, line: r.line, query }) },
        snippetEl(r.snippet, r.at, query.length),
      ),
    );
  }
  const files = new Set(data.results.map((r) => r.path)).size;
  rows.unshift(h('p', { class: 'search-summary' }, `${files}作品・${data.results.length}件${data.truncated ? '（多いので途中まで）' : ''}`));
  return rows;
}

function openSortPicker(folderPath) {
  const current = store.getFolderSort(folderPath);
  const options = [
    ['name-asc', '名前順（1話 › 2話）'],
    ['name-desc', '名前順（新しい話 › 古い話）'],
    ['mtime-desc', '更新日時順（新しい順）'],
    ['mtime-asc', '更新日時順（古い順）'],
    ['progress', '未読・続き優先'],
  ];
  openSheet(
    h('h2', {}, '一覧の並び順'),
    h(
      'div',
      { class: 'sort-options' },
      options.map(([key, label]) =>
        h(
          'button',
          {
            class: `sort-option${current === key ? ' selected' : ''}`,
            onclick: () => {
              store.setFolderSort(folderPath, key);
              closeSheet();
              refreshFiler();
            },
          },
          h('span', { class: 'label' }, label),
          current === key ? h('span', { class: 'check' }, '✓') : null,
        ),
      ),
    ),
  );
}

// 表示中のフォルダ。フォルダの一覧でなければ null
const currentFolder = () => (view?.type === 'folder' ? view.path : null);

$('.sort', filerEl).addEventListener('click', () => {
  openSortPicker(currentFolder() ?? '');
});

// 作品（シリーズ）の設定資料から、Gemini であらすじ・登場人物リストを自動生成して表示するシート
function openSummarySheet(dirPath) {
  const show = (...content) => openSheet(h('h2', {}, `「${basename(dirPath)}」の設定・あらすじ`), h('div', { class: 'summary-view' }, content));
  const generateButton = (label) => h('button', { type: 'button', class: 'summary-btn', onclick: generate }, label);

  function render(summary) {
    if (summary?.markdown) {
      show(
        renderMarkdown(summary.markdown),
        h('div', { class: 'summary-meta' }, `生成日時: ${shortDate(summary.updatedAt)}`),
        generateButton('あらすじと登場人物を再生成'),
      );
    } else {
      show(
        h(
          'div',
          { class: 'summary-empty' },
          '全体ロードマップやキャラシートから、Gemini (3.8 Flash Medium) であらすじと登場人物リストを自動生成します。\n（※本文や各話プロットは読みません）',
        ),
        generateButton('あらすじ・登場人物を生成'),
      );
    }
  }

  async function generate() {
    show(h('div', { class: 'summary-empty' }, '全体ロードマップやキャラシートから、あらすじと登場人物リストを生成中…（Gemini 3.8 Flash Medium）'));
    try {
      render((await generateSummary(dirPath)).summary);
    } catch (e) {
      toast(`生成できませんでした: ${e.message}`);
      void load();
    }
  }

  async function load() {
    try {
      render((await fetchSummary(dirPath)).summary);
    } catch {
      render(null);
    }
  }

  show('読み込み中…');
  void load();
}

$('.summary', filerEl).addEventListener('click', () => {
  if (currentFolder()) openSummarySheet(currentFolder());
});

// iOS はタップの処理の中で focus しないとキーボードを出さないので、hashchange を待たずにその場で検索を開く。
// シリーズのフォルダの中で押したときは、そのシリーズの中だけを探す
$('.search', filerEl).addEventListener('click', () => {
  const searching = view?.type === 'search' ? view : null;
  const series = searching ? searching.series : currentFolder() ? currentFolder().split('/')[0] : null;
  const hash = searchRoute(searching?.query ?? '', series);
  if (location.hash !== hash) {
    history.pushState(null, '', hash);
    route();
  }
  $('.search-form input', filerEl)?.focus();
});

// トップの一覧にいるときは、一覧のいちばん上へ戻る
$('.home', filerEl).addEventListener('click', () => {
  if (currentFolder() === '') window.scrollTo({ top: 0, behavior: 'smooth' });
  else location.hash = dirRoute('');
});

// ページ自体をブラウザ的に再読み込みする。Service Worker の更新チェックも挟む
async function reloadPage() {
  if (currentFile) reader.flushSave();
  toast('ページを再読み込みしています…');
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {}
  location.reload();
}

attachLongPress($('.reload', filerEl), reloadPage, refreshFiler);

// リーダー

// 開いているファイルと同じフォルダの一覧（目次と次の話に使う）
let siblings = null;

// 検索から本文を開いたときの、検索結果のルート。メニューの戻るで、フォルダではなく検索結果に戻る。
// 続けて次の話などを開いても保ち、ファイラーから開き直したら忘れる
let backToSearch = null;

async function openReader(path) {
  hideMenu();
  closeSheet();
  closeViewer();
  if (view?.type === 'search' && view.query) backToSearch = searchRoute(view.query, view.series);
  else if (!currentFile) backToSearch = null;
  $('.back', menuEl).textContent = backToSearch ? '‹ 検索' : '‹ フォルダ';
  rememberScroll();
  view = null;
  filerEl.hidden = true;
  readerEl.hidden = false;
  currentFile = path;
  $('.title', menuEl).textContent = displayName(path);
  $('.series', menuEl).textContent = seriesOf(path) ?? '';
  $('.menu-marks', menuEl).replaceChildren(...markButtons(path));
  document.title = displayName(path);
  siblings = fetchList(dirname(path));
  const next = siblings.then((list) => episodeNextTo(list, path, 1));
  const prev = siblings.then((list) => episodeNextTo(list, path, -1));
  const initialPage = pendingInitialPage;
  pendingInitialPage = null;
  try {
    const { fromCache } = await reader.open(path, settings, { nextPromise: next, prevPromise: prev, initialPage });
    if (pendingJump?.path === path && currentFile === path) reader.jumpTo(pendingJump.line, pendingJump.query);
    pendingJump = null;
    toastIfCached({ fromCache }, '本文');
  } catch (e) {
    if (currentFile !== path) return;
    store.deletePosition(path);
    toast(`読み込めませんでした: ${e.message}`);
    location.replace(dirRoute(dirname(path)));
  }
}

// フォルダの一覧 list の中で、path の次（offset が 1）か前（-1）の話 { name, path, href }。なければ null
function episodeNextTo(list, path, offset) {
  const files = sortedFiles(list);
  const i = files.findIndex((f) => childPath(list.path, f.name) === path);
  const f = i >= 0 ? files[i + offset] : null;
  if (!f) return null;
  const filePath = childPath(list.path, f.name);
  return { name: displayName(f.name), path: filePath, href: fileRoute(filePath) };
}

// フォルダを読み直して、目次と前後の話を新しい話に追いつかせる
async function reloadSiblings() {
  const path = currentFile;
  siblings = fetchList(dirname(path));
  const list = await siblings.catch(() => null);
  if (list && currentFile === path) {
    reader.setEpisodes({ next: episodeNextTo(list, path, 1), prev: episodeNextTo(list, path, -1) });
  }
  return list;
}

function handleTap(zone) {
  if (!sheetEl.hidden) return closeSheet();
  if (!menuEl.hidden) return hideMenu();
  if (zone === 'next') reader.next();
  else if (zone === 'prev') reader.prev();
  else showMenu();
}

function updatePageInfo(page, pages) {
  slider.max = String(pages);
  slider.value = String(page + 1);
  // 自前で描くスライダーの、読んだ分を塗る範囲
  slider.style.setProperty('--fill', `${pages > 1 ? (page / (pages - 1)) * 100 : 100}%`);
  $('.pageinfo', menuEl).textContent = `${page + 1} / ${pages}（${Math.floor(((page + 1) / pages) * 100)}%）`;

  const metricsEl = $('.reading-metrics', menuEl);
  if (metricsEl) metricsEl.textContent = readingMetricsText(reader.getReadingMetrics(), page, pages);
}

// 「12,345 字（原稿用紙 31 枚） / 読了目安 約 25 分（残り約 10 分）」
function readingMetricsText(metrics, page, pages) {
  if (!metrics?.chars) return '';
  const { chars, manuscriptPages, readingMinutes } = metrics;
  let time = `読了目安 約 ${readingMinutes} 分`;
  if (pages > 1 && page === pages - 1) {
    time = '読了';
  } else if (pages > 1 && page > 0) {
    const remaining = Math.max(1, Math.round(readingMinutes * ((pages - 1 - page) / pages)));
    time = `読了目安 約 ${readingMinutes} 分（残り約 ${remaining} 分）`;
  }
  return `${chars.toLocaleString()} 字（原稿用紙 ${manuscriptPages} 枚） / ${time}`;
}

function showMenu() {
  menuEl.hidden = false;
}

// 表示設定を開いている間に隠したメニューは、閉じたら出し直す。
// 別の画面へ移るなど、表示設定とは別の理由で隠したときは出し直さない
let menuHiddenBySettings = false;

function hideMenu() {
  menuEl.hidden = true;
  menuHiddenBySettings = false;
}

slider.addEventListener('input', () => reader.go(Number(slider.value) - 1, { save: false }));
slider.addEventListener('change', () => reader.save());

$('.back', menuEl).addEventListener('click', () => {
  location.hash = backToSearch ?? dirRoute(dirname(currentFile ?? ''));
});

$('.home', menuEl).addEventListener('click', () => {
  location.hash = dirRoute('');
});

const actions = {
  toc: openToc,
  notes: () => openNotesSheet(),
  search: openInFileSearch,
  settings: openSettings,
  async reload() {
    const [r] = await Promise.all([reader.reload().catch((e) => ({ error: e })), reloadSiblings()]);
    if (r.error) toast(`読み込めませんでした: ${r.error.message}`);
    else if (r.changed) toast('最新の内容に更新しました');
    else if (r.fromCache) toast('つながらないため、更新を確かめられませんでした');
    else toast('最新の状態です');
  },
};

$('.actions', menuEl).addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action) actions[action]();
});

attachLongPress($('[data-action="reload"]', menuEl), reloadPage);

// 付箋（推敲メモ）シート。上に入力欄（または追加ボタン）、下にこの話の付箋の一覧を出す。
// 本文の付箋の印から開いたときは、その付箋（noteId）か、その行（line）の付箋の入力欄を開いておく
function openNotesSheet(targetLine = null, targetNoteId = null) {
  if (!currentFile) return;
  hideMenu();
  const filePath = currentFile;

  // 開いている入力欄。null なら閉じている。
  // note は書き直す付箋（新しく付けるときは null）、line は新しく付ける行（null なら今のページの先頭）
  let form = null;
  if (targetNoteId !== null || targetLine !== null) {
    const notes = store.getNotesForPath(filePath);
    const note = targetNoteId !== null ? notes.find((n) => n.id === targetNoteId) : notes.find((n) => n.line === targetLine);
    form = { note: note ?? null, line: targetLine };
  }

  const setForm = (next) => {
    form = next;
    render();
  };

  function render() {
    const notes = store.getNotesForPath(filePath);
    openSheet(
      h('h2', {}, '付箋（推敲メモ）'),
      h(
        'div',
        { class: 'notes-view' },
        form
          ? noteForm(notes)
          : h('button', { type: 'button', class: 'note-add-btn', onclick: () => setForm({ note: null, line: null }) }, '＋ このページの位置に付箋を追加'),
        !notes.length && !form ? emptyRow('この作品の付箋はまだありません') : notes.map(noteItem),
      ),
    );
  }

  // 入力欄の付箋を付ける位置
  function formPosition() {
    if (form.note) return { line: form.note.line, off: form.note.off ?? 0, snippet: form.note.snippet };
    const here = reader.currentLineInfo();
    return form.line === null ? here : { line: form.line, off: 0, snippet: here.snippet };
  }

  function noteForm(notes) {
    const editing = form.note;
    const { line, off, snippet } = formPosition();
    const textarea = h('textarea', { placeholder: 'メモを入力（空欄でも保存できます）', 'aria-label': 'メモ本文' });
    if (editing) textarea.value = editing.text;
    const save = () => {
      // 同じ位置に付箋があれば、新しく作らずにそれを書き直す
      const samePlace = notes.find((n) => n.line === line && (n.off ?? 0) === off);
      store.saveNote({ id: editing?.id ?? samePlace?.id, path: filePath, line, off, snippet, text: textarea.value.trim() });
      reader.markNotes();
      setForm(null);
    };
    const remove = () => {
      store.deleteNote(editing.id);
      reader.markNotes();
      setForm(null);
    };
    return h(
      'div',
      { class: 'note-form' },
      h('div', { class: 'note-item-snippet' }, `第 ${line + 1} 行${snippet ? `: ${snippet.slice(0, 30)}…` : ''}`),
      textarea,
      h(
        'div',
        { class: 'note-form-buttons' },
        editing ? h('button', { type: 'button', class: 'delete', onclick: remove }, '削除') : null,
        h('button', { type: 'button', onclick: () => setForm(null) }, 'キャンセル'),
        h('button', { type: 'button', class: 'save', onclick: save }, '保存'),
      ),
    );
  }

  // 一覧の付箋。押すとその位置へ移る
  function noteItem(note) {
    // 押しても、付箋の位置へ移らないようにする
    const action = (label, className, run) => {
      const onclick = (e) => {
        e.stopPropagation();
        run();
      };
      return h('button', { type: 'button', class: className, onclick }, label);
    };
    const remove = () => {
      store.deleteNote(note.id);
      reader.markNotes();
      if (form?.note?.id === note.id) form = null;
      render();
    };
    return h(
      'div',
      {
        class: 'note-item',
        onclick: () => {
          reader.jumpToNote(note);
          closeSheet();
          hideMenu();
        },
      },
      h('div', { class: 'note-item-header' }, h('span', {}, `第 ${note.line + 1} 行`), h('span', {}, shortDate(note.updatedAt))),
      note.snippet ? h('div', { class: 'note-item-snippet' }, note.snippet) : null,
      note.text ? h('div', { class: 'note-item-text' }, note.text) : null,
      h(
        'div',
        { class: 'note-item-actions' },
        action('編集', null, () => setForm({ note, line: null })),
        action('削除', 'delete', remove),
      ),
    );
  }

  render();
}

// 差分（ビフォー・アフター）の詳細シート。hunks は本文のすべての変更のまとまりで、hunk はそのうち index 番目
function openDiffSheet(hunk, hunks = [], index = 0) {
  const deletedText = hunk.deleted?.join('\n') ?? '';
  const addedText = hunk.added?.join('\n') ?? '';
  const empty = (text = '（なし）') => h('span', { class: 'diff-empty' }, text);

  let before;
  let after;
  if (deletedText === BASELINE_MISSING) {
    // 比べる相手がないので、変更後をそのまま出す
    before = [empty(deletedText)];
    after = addedText ? [addedText] : [empty()];
  } else {
    const tokens = diffChars(deletedText, addedText);
    const tokenNode = (t) => {
      if (t.type === 'delete') return h('del', { class: 'diff-del' }, t.text);
      if (t.type === 'insert') return h('ins', { class: 'diff-ins' }, t.text);
      return t.text;
    };
    const render = (list) => (list.length ? list.map(tokenNode) : [empty()]);
    before = render(tokens.before);
    after = render(tokens.after);
  }

  // 縦書きの本文と同じく、左が後ろ（次の変更）、右が前（前の変更）
  const goTo = (i) => {
    reader.jumpTo(hunks[i].line);
    openDiffSheet(hunks[i], hunks, i);
  };
  const nav =
    hunks.length > 1
      ? h(
          'div',
          { class: 'diff-nav' },
          h('button', { disabled: index >= hunks.length - 1, onclick: () => goTo(index + 1) }, '‹ 次の変更'),
          h('span', { class: 'diff-count' }, `${index + 1} / ${hunks.length}`),
          h('button', { disabled: index <= 0, onclick: () => goTo(index - 1) }, '前の変更 ›'),
        )
      : null;

  const pane = (className, label, children) =>
    h(
      'div',
      { class: `diff-pane ${className}` },
      h('div', { class: 'diff-header' }, label),
      h('div', { class: 'diff-box' }, h('div', { class: 'diff-text' }, ...children)),
    );
  openSheet(h('h2', {}, '変更箇所の差分'), nav, h('div', { class: 'diff-view' }, pane('deleted', '変更前', before), pane('added', '変更後', after)));
  sheetEl.classList.add('diff');

  // 縦書きなので、右端（文頭）から見せる
  requestAnimationFrame(() => {
    const view = $('.diff-view', sheetEl);
    if (view) view.scrollLeft = view.scrollWidth;
  });
}

// 目次・表示設定のシート

function openSheet(...children) {
  $('.sheet-body', sheetEl).replaceChildren(...children.flat(Infinity).filter((c) => c != null));
  sheetEl.classList.remove('top', 'settings', 'diff');
  sheetEl.hidden = false;
}

// 上から出すシート。検索の入力欄がキーボードに隠れないようにする
function openTopSheet(...children) {
  openSheet(...children);
  sheetEl.classList.add('top');
}

function closeSheet() {
  sheetEl.hidden = true;
  if (menuHiddenBySettings) showMenu();
  menuHiddenBySettings = false;
}

$('.close', sheetEl).addEventListener('click', closeSheet);
sheetEl.addEventListener('click', (e) => {
  if (e.target === sheetEl) closeSheet();
});

// 1 話 1 ファイルなので、同じフォルダのファイルをファイル名順に並べて目次にする。
// reload なら開いたときの一覧を使わず、フォルダを読み直して新しい話を拾う
async function openToc({ reload = false } = {}) {
  let list = reload ? null : await siblings.catch(() => null);
  if (!list) list = await reloadSiblings();
  const reloadButton = h('button', { class: 'icon sheet-reload', 'aria-label': '目次を読み直す', onclick: reloadToc }, '↻');
  if (!list) {
    openSheet(h('h2', {}, '目次'), h('p', { class: 'empty' }, '一覧を読み込めませんでした'), reloadButton);
    return;
  }
  openSheet(
    reloadButton,
    h('h2', {}, '目次'),
    sortedFiles(list).map((f) => {
      const filePath = childPath(list.path, f.name);
      return h(
        'a',
        { class: `toc-item${filePath === currentFile ? ' current' : ''}`, href: fileRoute(filePath), onclick: closeSheet },
        h('span', { class: 'text' }, displayName(f.name)),
        h('span', { class: 'num' }, progressText(store.getPosition(filePath))),
      );
    }),
  );
  if (!reload) $('.toc-item.current', sheetEl)?.scrollIntoView({ block: 'center' });
}

// スクロール位置を保ったまま目次を読み直す
async function reloadToc() {
  const body = $('.sheet-body', sheetEl);
  const top = body.scrollTop;
  await openToc({ reload: true });
  body.scrollTop = top;
  const list = await siblings.catch(() => null);
  toastIfCached(list, '目次');
}

// 読んでいる作品の中を探す。結果を押すとそのページへ移り、見つかった言葉に印を付ける
let lastInFileQuery = '';

function openInFileSearch() {
  const input = h('input', { type: 'search', enterkeyhint: 'search', placeholder: 'この作品から検索', 'aria-label': '検索する言葉' });
  input.value = lastInFileQuery;
  const results = h('div', { class: 'search-results' });
  const run = () => {
    const query = input.value.trim();
    lastInFileQuery = query;
    if (!query) return results.replaceChildren();
    const matches = reader.search(query);
    results.replaceChildren(
      h('p', { class: 'search-summary' }, matches.length ? `${matches.length}件` : `「${query}」は見つかりませんでした`),
      ...matches.map((m) =>
        h(
          'button',
          {
            class: 'search-hit',
            onclick: () => {
              closeSheet();
              hideMenu();
              reader.showMatch(m);
            },
          },
          h('span', { class: 'num' }, `${m.page + 1}`),
          snippetEl(m.snippet, m.at, m.length),
        ),
      ),
    );
  };
  const form = h(
    'form',
    {
      class: 'search-form',
      onsubmit: (e) => {
        e.preventDefault();
        input.blur();
        run();
      },
    },
    withClearButton(input),
  );
  openTopSheet(h('h2', {}, '検索'), form, results);
  if (lastInFileQuery) run();
  else input.focus();
}

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  store.saveSettings(settings);
  applyTheme();
  if (currentFile) reader.applySettings(settings);
  openSettings();
}

// 刻みの倍数にそろえて上げ下げする。下限が刻みの倍数でないとき（左右の余白の 0.5em）も、そこから上げれば倍数に戻る
function stepper(label, value, format, step, min, max, key) {
  const round = (v) => Math.round(v * 100) / 100;
  const units = round(value / step);
  const down = round(Math.max(min, (Math.ceil(units) - 1) * step));
  const up = round(Math.min(max, (Math.floor(units) + 1) * step));
  return h(
    'div',
    { class: 'setting' },
    h('span', {}, label),
    h(
      'div',
      { class: 'stepper' },
      h('button', { onclick: () => updateSettings({ [key]: down }), 'aria-label': `${label}を下げる` }, '−'),
      h('span', { class: 'value' }, format(value)),
      h('button', { onclick: () => updateSettings({ [key]: up }), 'aria-label': `${label}を上げる` }, '+'),
    ),
  );
}

function segmented(label, key, options) {
  return h(
    'div',
    { class: 'setting' },
    h('span', {}, label),
    h(
      'div',
      { class: 'segmented' },
      options.map(([value, text]) => h('button', { 'aria-pressed': String(settings[key] === value), onclick: () => updateSettings({ [key]: value }) }, text)),
    ),
  );
}

function openSettings() {
  // 見た目を確かめながら調整できるよう、メニューを隠す
  if (!menuEl.hidden) {
    hideMenu();
    menuHiddenBySettings = true;
  }
  openSheet(
    h('h2', {}, '表示設定'),
    stepper('文字サイズ', settings.fontSize, (v) => `${v}px`, 1, 12, 32, 'fontSize'),
    stepper('行間', settings.lineHeight, (v) => v.toFixed(1), 0.1, 1.4, 2.6, 'lineHeight'),
    // 本文の文字の大きさを 1em とする。左右はルビが画面の外へ切れない分を残す
    stepper('上下の余白', settings.marginBlockEm, (v) => `${v.toFixed(1)}em`, 0.5, 1, 6, 'marginBlockEm'),
    stepper('左右の余白', settings.marginInlineEm, (v) => `${v}em`, 1, 0.5, store.WIDE_QUERY.matches ? 20 : 4, 'marginInlineEm'),
    segmented('フォント', 'font', [
      ['mincho', '明朝'],
      ['rinmincho', '倫明朝'],
      ['gothic', 'ゴシック'],
    ]),
    segmented('テーマ', 'theme', [
      ['light', 'ライト'],
      ['dark', 'ダーク'],
      ['sepia', 'セピア'],
    ]),
  );
  sheetEl.classList.add('settings');
}

// 画面の向きが変わったら、今読んでいる位置を基準に組み直す
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentFile) reader.relayout();
  }, 200);
});

// 確認ダイアログ。OK なら true、キャンセルなら false を返す。外側のタップでは閉じない
let closeDialog = null;
function confirmDialog({ title, message, ok = 'OK', cancel = 'キャンセル' }) {
  closeDialog?.(false);
  $('.dialog-title', dialogEl).textContent = title;
  $('.dialog-message', dialogEl).textContent = message;
  const okEl = $('.dialog-ok', dialogEl);
  const cancelEl = $('.dialog-cancel', dialogEl);
  okEl.textContent = ok;
  cancelEl.textContent = cancel;
  dialogEl.hidden = false;
  okEl.focus({ preventScroll: true });
  return new Promise((resolve) => {
    const finish = (result) => {
      closeDialog = null;
      dialogEl.hidden = true;
      okEl.onclick = cancelEl.onclick = null;
      resolve(result);
    };
    closeDialog = finish;
    okEl.onclick = () => finish(true);
    cancelEl.onclick = () => finish(false);
  });
}

// サーバーから取り込んだ印や読書位置を、表示中の一覧に反映する
function applySyncedData() {
  settings = store.loadSettings();
  applyTheme();
  if (!filerEl.hidden) refreshFiler();
}

// 別の端末で先まで読み進められていたら、そのページへ移るか尋ねる。
// 断ったら、同じ位置（より先に進まれるまで）は二度と尋ねない
let declinedRemote = null;
async function offerRemotePosition() {
  if (!currentFile || readerEl.hidden) return;
  const pos = reader.remoteAhead();
  if (!pos) return;
  const path = currentFile;
  if (declinedRemote?.path === path && declinedRemote.updatedAt >= pos.updatedAt) return;
  const at = progressText(pos);
  const ok = await confirmDialog({
    title: '別の端末で先まで読んでいます',
    message: `別の端末で${at ? ` ${at} のところ` : '先'}まで読み進められています。そのページへ移動しますか？`,
    ok: '移動する',
    cancel: 'このまま読む',
  });
  if (ok) {
    if (currentFile === path) reader.goToPosition(pos);
  } else {
    declinedRemote = { path, updatedAt: pos.updatedAt };
  }
}

// アプリに戻ってきた（ウィンドウがアクティブになった）とき、サーバーと同期し、
// 他の端末で読み進められていれば移動を尋ね、開いているファイルが更新されていれば読み直す。
// 離れるときは読書位置を保存する
let syncingOnActivate = false;
async function onActivate() {
  if (syncingOnActivate) return;
  syncingOnActivate = true;
  try {
    await store.syncWithServer(applySyncedData);
    if (!currentFile) return;
    const r = await reader.checkUpdate();
    if (r.changed) toast('ファイルが更新されていたので読み直しました');
    await offerRemotePosition();
  } finally {
    syncingOnActivate = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    if (currentFile) reader.flushSave();
    return;
  }
  void onActivate();
});

// PC ではウィンドウを切り替えても表示状態は変わらないので、フォーカスでも確かめる
window.addEventListener('focus', onActivate);

window.addEventListener('pagehide', () => {
  if (currentFile) reader.flushSave();
});

let waitingKeyUp = false;
window.addEventListener('keyup', () => {
  waitingKeyUp = false;
});
window.addEventListener('blur', () => {
  waitingKeyUp = false;
});

document.addEventListener('keydown', (e) => {
  if (!dialogEl.hidden) {
    if (e.key === 'Escape') closeDialog?.(false);
    return;
  }
  if (isViewerOpen()) {
    if (e.key === 'Escape') closeViewer();
    return;
  }
  if (e.key === 'Escape') {
    if (!sheetEl.hidden) closeSheet();
    else if (!menuEl.hidden) hideMenu();
    return;
  }
  if (!currentFile || !sheetEl.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  // 入力欄やスライダーのキー操作と、ボタンをスペースキーで押すのは邪魔しない
  if (e.target.closest('input, textarea, select') || (e.key === ' ' && e.target.closest('button, a'))) return;
  const allowEpisode = !e.repeat;
  const page = {
    ArrowLeft: () => reader.next({ allowEpisode }),
    ArrowDown: () => reader.next({ allowEpisode }),
    PageDown: () => reader.next({ allowEpisode }),
    ArrowRight: () => reader.prev({ allowEpisode }),
    ArrowUp: () => reader.prev({ allowEpisode }),
    PageUp: () => reader.prev({ allowEpisode }),
    ' ': () => (e.shiftKey ? reader.prev({ allowEpisode }) : reader.next({ allowEpisode })),
    Home: () => reader.go(0),
    End: () => reader.go(reader.pages - 1),
  }[e.key];
  if (!page) return;
  e.preventDefault();
  if (waitingKeyUp) return;
  const res = page();
  if (res === 'episode') waitingKeyUp = true;
});

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('sw.js');
}

applyTheme();
window.addEventListener('hashchange', route);
if (!location.hash) {
  const last = store.getLastRoute();
  if (last) history.replaceState(null, '', last);
}
// 開く話の読書位置を決める前に他の端末の位置を取り込めるよう、画面を開く前に同期を始めておく
void store.syncWithServer(applySyncedData);
route();
