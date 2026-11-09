import { Reader } from './reader.js';
import { openViewer, closeViewer, isViewerOpen } from './viewer.js';
import { fetchList, fetchRecentlyUpdated, fetchTexts, searchAll, dirname, basename, largeImageUrl, iconUrl, saveIconSetting, generateIcon, fetchSummary, generateSummary } from './api.js';
import { PRESET_GROUPS, hasPreset, presetIcon } from './presets.js';
import { diffChars } from './diff.js';
import * as store from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);

const filerEl = $('#filer');
const readerEl = $('#reader');
const menuEl = $('#menu');
const sheetEl = $('#sheet');
const toastEl = $('#toast');
const dialogEl = $('#dialog');
const slider = $('.slider', menuEl);

let settings = store.loadSettings();
let currentFile = null;
// フォルダごとの一覧のスクロール位置（リーダーから戻ったときに元の場所を表示するため）
const scrollPositions = new Map();

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
window.__openDiffSheet = openDiffSheet;
window.__reader = reader;

// iOS Safari は画面の端から払うとブラウザの戻る・進むになり、ページをめくるつもりが前の画面に戻ってしまう。
// 本文と挿絵では端で触れ始めたときの既定の動きを止める。ページめくりは pointer イベントで受けるので止まらない。
// リンクやボタンは click が要るので止めない
const EDGE_WIDTH = 32;
document.addEventListener('touchstart', (e) => {
  const x = e.touches[0].clientX;
  if (x > EDGE_WIDTH && x < window.innerWidth - EDGE_WIDTH) return;
  if (!e.target.closest('#reader, #viewer') || e.target.closest('a, button')) return;
  e.preventDefault();
}, { passive: false });

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
      if (k in el) el[k] = v;
    } else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null));
  return el;
}

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
// アプリの名前。パンくずのルートに使う
let rootName = 'ユニコブック';

const HOME_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7M6 9v10.5h4.5V14h3v5.5H18V9" /></svg>';
const UNICO_ICON_HTML = '<img class="unico-icon" src="icons/icon-192.png" alt="ユニコブック" />';

function updateHomeButton(isTop) {
  const btn = $('.home', filerEl);
  if (!btn) return;
  btn.classList.toggle('is-top', isTop);
  btn.setAttribute('aria-label', isTop ? 'ユニコブック' : 'トップのフォルダへ');
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

function route() {
  const hash = location.hash || dirRoute('');
  store.setLastRoute(hash);
  const file = hash.match(/^#\/r\/(.*)$/);
  const marked = hash.match(/^#\/m\/(\w+)$/);
  const seriesSearch = hash.match(/^#\/search-in\/([^/]+)(?:\/(.*))?$/);
  if (file) openReader(decodeURIComponent(file[1]));
  else if (hash === UPDATED_ROUTE) openUpdated();
  else if (hash === HISTORY_ROUTE) openHistory();
  else if (seriesSearch) openSearch(decodeURIComponent(seriesSearch[2] ?? ''), decodeURIComponent(seriesSearch[1]));
  else if (hash.startsWith('#/search')) openSearch(decodeURIComponent(hash.match(/^#\/search\/(.*)$/)?.[1] ?? ''));
  else if (marked && MARKS[marked[1]]) openMarked(marked[1]);
  else openFiler(decodeURIComponent(hash.match(/^#\/d\/(.*)$/)?.[1] ?? ''));
}

// ファイラー

// 表示中のフォルダ（印の一覧・最近の更新のときは null）と、スクロール位置を覚えるためのキー
let filerPath = null;
let markedKind = null;
let showingUpdated = false;
let showingHistory = false;
let searchQuery = null;
// シリーズの中だけを検索しているときのシリーズ名（searchQuery が null でないときだけ意味を持つ）
let searchSeries = null;
let filerKey = null;

function showFiler(key) {
  hideMenu();
  closeSheet();
  closeViewer();
  if (currentFile) {
    reader.close();
    currentFile = null;
  }
  readerEl.hidden = true;
  filerEl.hidden = false;
  $('.sort', filerEl).disabled = false;
  $('.summary', filerEl).hidden = true;
  if (filerKey !== null) scrollPositions.set(filerKey, window.scrollY);
  filerKey = key;
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

const upRow = (href) =>
  h('div', { class: 'row up' }, h('a', { class: 'main', href }, icon('up'), h('span', { class: 'name' }, '..')));

async function openFiler(path) {
  showFiler(path);
  filerPath = path;
  updateHomeButton(!path);
  $('.summary', filerEl).hidden = !path;
  markedKind = null;
  showingUpdated = false;
  showingHistory = false;
  searchQuery = null;
  document.title = path ? basename(path) : 'ユニコブック';
  try {
    const data = await fetchList(path);
    store.setSeriesIcons(data.seriesIcons);
    if (filerPath !== path) return;
    renderFiler(data);
    window.scrollTo(0, scrollPositions.get(path) ?? 0);
    if (data.fromCache) toast('つながらないため、保存済みの一覧を表示しています');
  } catch (e) {
    if (filerPath !== path) return;
    $('.crumbs', filerEl).replaceChildren(path || 'ユニコブック');
    $('.list', filerEl).replaceChildren(h('p', { class: 'empty' }, `読み込めませんでした`, h('br'), e.message));
  }
}

function renderFiler(data) {
  const { root, path } = data;
  rootName = 'ユニコブック';
  const segments = path ? path.split('/') : [];
  const crumbs = path
    ? segments.map((name, i) => ({ name, href: dirRoute(segments.slice(0, i + 1).join('/')) }))
    : [{ name: 'ユニコブック', href: dirRoute('') }];
  setCrumbs(crumbs);
  updateHomeButton(!path);

  const rows = [];
  if (!path) {
    const existingPaths = new Set([
      ...data.files.map((f) => f.name),
      ...data.dirs.flatMap((d) => (d.texts ?? []).map((t) => (typeof t === 'string' ? t : t.path))),
    ]);

    // キャッシュからの表示でなければ、存在しないファイルの読書位置を削除する
    if (!data.fromCache) {
      const missing = Object.keys(store.getPositions()).filter((p) => !existingPaths.has(p));
      if (missing.length) store.deletePositions(missing);
    }

    // 削除されたファイルを除き、1 件多く取り、続きがあれば履歴の一覧への入口を出す
    const validRecent = store.getRecent().filter((r) => existingPaths.has(r.path));
    const recent = validRecent.slice(0, RECENT_COUNT + 1);
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
      h('a', { class: 'shortcut', href }, icon(iconName), h('span', { class: 'label' }, label), count == null ? null : h('span', { class: 'count' }, String(count)));
    rows.push(
      h(
        'nav',
        { class: 'shortcuts' },
        Object.entries(MARKS).map(([kind, { label, icon: iconName }]) =>
          shortcut(markedRoute(kind), iconName, label, store.getMarked(kind).length),
        ),
        shortcut(UPDATED_ROUTE, 'clock', '最近の更新'),
      ),
    );
    rows.push(h('h2', { class: 'section-label' }, '一覧'));
  } else {
    rows.push(upRow(dirRoute(dirname(path))));
  }

  const sortMode = store.getFolderSort(path ?? '');
  const pins = store.getPins();
  const isPinned = (p) => p in pins;

  const compareItems = (a, b) => {
    if (sortMode === 'name-desc') return b.name.localeCompare(a.name, 'ja', { numeric: true });
    if (sortMode === 'mtime-desc') return (b.mtime ?? 0) - (a.mtime ?? 0) || a.name.localeCompare(b.name, 'ja', { numeric: true });
    if (sortMode === 'mtime-asc') return (a.mtime ?? 0) - (b.mtime ?? 0) || a.name.localeCompare(b.name, 'ja', { numeric: true });
    if (sortMode === 'progress') {
      const finA = isFinished(store.getPosition(a.path)) ? 1 : 0;
      const finB = isFinished(store.getPosition(b.path)) ? 1 : 0;
      if (finA !== finB) return finA - finB;
      return a.name.localeCompare(b.name, 'ja', { numeric: true });
    }
    return a.name.localeCompare(b.name, 'ja', { numeric: true });
  };

  const dirItems = data.dirs.map((d) => {
    const p = childPath(path, d.name);
    const mtime = d.texts?.length ? Math.max(...d.texts.map((t) => t.mtime ?? 0)) : 0;
    return { type: 'dir', d, path: p, name: d.name, mtime, pinned: isPinned(p) };
  });

  const fileItems = data.files.map((f) => {
    const p = childPath(path, f.name);
    return { type: 'file', f, path: p, name: f.name, mtime: f.mtime, pinned: isPinned(p) };
  });

  // ピン留めされた項目（フォルダソート順に従って上部に固定表示）
  const pinnedDirs = dirItems.filter((i) => i.pinned).sort(compareItems);
  const pinnedFiles = fileItems.filter((i) => i.pinned).sort(compareItems);

  // 通常の項目
  const normalDirs = dirItems.filter((i) => !i.pinned).sort(compareItems);
  const normalFiles = fileItems.filter((i) => !i.pinned).sort(compareItems);

  for (const item of pinnedDirs) {
    rows.push(dirRow(item.path, { iconInfo: item.d.icon, texts: item.d.texts, pinned: true }));
  }
  for (const item of pinnedFiles) {
    rows.push(fileRow(item.path, { mtime: item.f.mtime, pinned: true }));
  }
  for (const item of normalDirs) {
    rows.push(dirRow(item.path, { iconInfo: item.d.icon, texts: item.d.texts, pinned: false }));
  }
  for (const item of normalFiles) {
    rows.push(fileRow(item.path, { mtime: item.f.mtime, pinned: false }));
  }
  if (!data.dirs.length && !data.files.length) {
    rows.push(h('p', { class: 'empty' }, 'このフォルダには表示できるファイルがありません'));
  }
  $('.list', filerEl).replaceChildren(...rows);
  markUpdatedLater($('.list', filerEl));
}

// シリーズ名は小説フォルダ直下のフォルダ名。直下のファイルにはない
const seriesOf = (path) => (path.includes('/') ? path.split('/')[0] : null);

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
          h('button', { class: `preset-choice${current === p.id ? ' selected' : ''}`, 'aria-label': p.text ?? p.id, onclick: () => choose(p.id) }, presetIcon(p.id)),
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
    h(
      'div',
      { class: 'icon-file' },
      fileIcon(dirPath, iconInfo.version, 'dir'),
      h('span', { class: 'icon-file-name' }, `フォルダの画像（${iconInfo.file}）`),
    ),
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
          if (!generateButton.disabled) generate();
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
    { class: `row file${recent ? ' recent' : ''}${pinned ? ' pinned' : ''}${updated ? ' updated' : ''}`, 'data-check-updated': mtime == null ? filePath : null },
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
  showFiler(`@${kind}`);
  $('.sort', filerEl).disabled = true;
  filerPath = null;
  markedKind = kind;
  showingUpdated = false;
  showingHistory = false;
  searchQuery = null;
  const { label } = MARKS[kind];
  document.title = label;
  setCrumbs([{ name: label }]);
  updateHomeButton(false);
  const items = store.getMarked(kind);
  const parentLabel = (path) => (path.includes('/') ? dirname(path).split('/').join(' / ') : null);
  const rows = [upRow(dirRoute(''))];
  for (const { path } of items) {
    const label = parentLabel(path);
    rows.push(
      path.toLowerCase().endsWith('.txt')
        ? fileRow(path, { label, withSeriesIcon: true })
        : dirRow(path, { label, iconInfo: path.includes('/') ? null : store.getSeriesIcons()[path], withSeriesIcon: true }),
    );
  }
  if (!items.length) rows.push(h('p', { class: 'empty' }, `${label}はまだありません`));
  $('.list', filerEl).replaceChildren(...rows);
  markUpdatedLater($('.list', filerEl));
  window.scrollTo(0, scrollPositions.get(filerKey) ?? 0);
}

// 開いた履歴。最後に開いた順に最大 HISTORY_COUNT 件で、開いた日も添える
function openHistory() {
  showFiler('@history');
  $('.sort', filerEl).disabled = true;
  filerPath = null;
  markedKind = null;
  showingUpdated = false;
  showingHistory = true;
  searchQuery = null;
  document.title = '履歴';
  setCrumbs([{ name: '履歴' }]);
  updateHomeButton(false);
  const rows = [upRow(dirRoute(''))];
  for (const { path, pos } of store.getRecent(HISTORY_COUNT)) {
    rows.push(fileRow(path, { label: [seriesOf(path), updatedText(pos.updatedAt)].filter(Boolean).join('　'), withSeriesIcon: true }));
  }
  if (rows.length === 1) rows.push(h('p', { class: 'empty' }, 'まだ何も開いていません'));
  $('.list', filerEl).replaceChildren(...rows);
  markUpdatedLater($('.list', filerEl));
  window.scrollTo(0, scrollPositions.get(filerKey) ?? 0);
}

function updatedText(mtime) {
  const d = new Date(mtime);
  const pad = (n) => String(n).padStart(2, '0');
  const md = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return d.getFullYear() < new Date().getFullYear() ? `${pad(d.getFullYear() % 100)}/${md}` : md;
}

// フォルダを横断して、更新日時が新しい順に最大 UPDATED_COUNT 件。並び順の根拠がわかるよう更新日も添える
async function openUpdated() {
  showFiler('@updated');
  $('.sort', filerEl).disabled = true;
  filerPath = null;
  markedKind = null;
  showingUpdated = true;
  showingHistory = false;
  searchQuery = null;
  document.title = '最近の更新';
  setCrumbs([{ name: '最近の更新' }]);
  updateHomeButton(false);
  try {
    const data = await fetchRecentlyUpdated(UPDATED_COUNT);
    store.setSeriesIcons(data.seriesIcons);
    if (!showingUpdated) return;
    setCrumbs([{ name: '最近の更新' }]);
    const rows = [upRow(dirRoute(''))];
    for (const f of data.files) {
      rows.push(fileRow(f.path, { label: [seriesOf(f.path), updatedText(f.mtime)].filter(Boolean).join('　'), withSeriesIcon: true, mtime: f.mtime }));
    }
    if (!data.files.length) rows.push(h('p', { class: 'empty' }, 'テキストファイルがありません'));
    $('.list', filerEl).replaceChildren(...rows);
    window.scrollTo(0, scrollPositions.get(filerKey) ?? 0);
    if (data.fromCache) toast('つながらないため、保存済みの一覧を表示しています');
  } catch (e) {
    if (!showingUpdated) return;
    $('.list', filerEl).replaceChildren(upRow(dirRoute('')), h('p', { class: 'empty' }, '読み込めませんでした', h('br'), e.message));
  }
}

// 小説フォルダ全体（series を渡したときはそのシリーズの中）からの検索。結果を押すと、その行のページを開いて見つかった言葉に印を付ける
let pendingJump = null;

async function openSearch(query, series = null) {
  showFiler(`@search:${series ?? ''}:${query}`);
  $('.sort', filerEl).disabled = true;
  filerPath = null;
  markedKind = null;
  showingUpdated = false;
  showingHistory = false;
  searchQuery = query;
  searchSeries = series;
  document.title = query ? `検索: ${query}` : '検索';
  setCrumbs([series ? { name: series, href: dirRoute(series) } : null, { name: '検索' }].filter(Boolean));
  updateHomeButton(false);
  const placeholder = series ? 'このシリーズから検索' : 'すべての作品から検索';
  const input = h('input', { type: 'search', enterkeyhint: 'search', placeholder, 'aria-label': '検索する言葉' });
  input.value = query;
  const form = h('form', { class: 'search-form', onsubmit: (e) => {
    e.preventDefault();
    input.blur();
    if (input.value.trim()) location.hash = searchRoute(input.value.trim(), series);
  } }, withClearButton(input));
  const results = h('div', { class: 'search-results' });
  $('.list', filerEl).replaceChildren(form, results);
  if (!query) {
    input.focus();
    return;
  }
  results.replaceChildren(h('p', { class: 'empty' }, '検索しています…'));
  try {
    const data = await searchAll(query, series);
    store.setSeriesIcons(data.seriesIcons);
    if (searchQuery !== query || searchSeries !== series) return;
    results.replaceChildren(...renderSearchResults(data, query));
    markUpdatedLater(results);
    window.scrollTo(0, scrollPositions.get(filerKey) ?? 0);
    if (data.fromCache) toast('つながらないため、保存済みの結果を表示しています');
  } catch (e) {
    if (searchQuery !== query || searchSeries !== series) return;
    results.replaceChildren(h('p', { class: 'empty' }, '検索できませんでした', h('br'), e.message));
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
      rows.push(fileRow(r.path, { label: r.path.includes('/') ? dirname(r.path).split('/').join(' / ') : null, withSeriesIcon: true }));
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

$('.sort', filerEl).addEventListener('click', () => {
  openSortPicker(filerPath ?? '');
});

// Markdown の簡易レンダリング（見出し・箇条書き・段落）
function renderMarkdown(md) {
  const container = document.createElement('div');
  container.className = 'summary-content';
  const lines = md.split('\n');
  let currentList = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      currentList = null;
      continue;
    }
    const hMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (hMatch) {
      currentList = null;
      const level = Math.min(hMatch[1].length + 1, 4);
      const hEl = document.createElement(`h${level}`);
      hEl.textContent = hMatch[2];
      container.append(hEl);
      continue;
    }
    const listMatch = line.match(/^[-*•]\s+(.*)$/);
    if (listMatch) {
      if (!currentList) {
        currentList = document.createElement('ul');
        container.append(currentList);
      }
      const li = document.createElement('li');
      li.textContent = listMatch[1];
      currentList.append(li);
      continue;
    }
    currentList = null;
    const p = document.createElement('p');
    p.textContent = line;
    container.append(p);
  }
  return container;
}

// 作品（シリーズ）の設定資料から、Gemini であらすじ・登場人物リストを自動生成して表示するシート
async function openSummarySheet(dirPath) {
  if (!dirPath) return;
  const seriesName = basename(dirPath);

  function renderView(summary, loading = false) {
    const content = [];
    if (loading) {
      content.push(
        h(
          'div',
          { class: 'summary-empty' },
          '全体ロードマップやキャラシートから、あらすじと登場人物リストを生成中…（Gemini 3.8 Flash Medium）',
        ),
      );
    } else if (summary?.markdown) {
      content.push(renderMarkdown(summary.markdown));
      content.push(
        h('div', { class: 'summary-meta' }, `生成日時: ${updatedText(summary.updatedAt)}`),
        h(
          'button',
          {
            type: 'button',
            class: 'summary-btn',
            onclick: () => generate(),
          },
          'あらすじと登場人物を再生成',
        ),
      );
    } else {
      content.push(
        h(
          'div',
          { class: 'summary-empty' },
          '全体ロードマップやキャラシートから、Gemini (3.8 Flash Medium) であらすじと登場人物リストを自動生成します。\n（※本文や各話プロットは読みません）',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'summary-btn',
            onclick: () => generate(),
          },
          'あらすじ・登場人物を生成',
        ),
      );
    }
    openSheet(h('h2', {}, `「${seriesName}」の設定・あらすじ`), h('div', { class: 'summary-view' }, content));
  }

  async function generate() {
    renderView(null, true);
    try {
      const res = await generateSummary(dirPath);
      renderView(res.summary);
    } catch (e) {
      toast(`生成できませんでした: ${e.message}`);
      load();
    }
  }

  async function load() {
    try {
      const { summary } = await fetchSummary(dirPath);
      renderView(summary);
    } catch {
      renderView(null);
    }
  }

  openSheet(h('h2', {}, `「${seriesName}」の設定・あらすじ`), h('div', { class: 'summary-view' }, '読み込み中…'));
  load();
}

$('.summary', filerEl).addEventListener('click', () => {
  if (filerPath) openSummarySheet(filerPath);
});

// iOS はタップの処理の中で focus しないとキーボードを出さないので、hashchange を待たずにその場で検索を開く。
// シリーズのフォルダの中で押したときは、そのシリーズの中だけを探す
$('.search', filerEl).addEventListener('click', () => {
  const series = searchQuery !== null ? searchSeries : filerPath ? filerPath.split('/')[0] : null;
  const hash = searchRoute(searchQuery ?? '', series);
  if (location.hash !== hash) {
    history.pushState(null, '', hash);
    route();
  }
  $('.search-form input', filerEl)?.focus();
});

$('.home', filerEl).addEventListener('click', () => {
  if (filerPath || markedKind || showingUpdated || showingHistory || searchQuery !== null) {
    location.hash = dirRoute('');
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
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

// 長押しで onLongPress、通常のタップで onClick（省略時はイベント伝播に任せる）を呼ぶ
function attachLongPress(el, onLongPress, onClick = null) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let suppressClick = false;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cancel();
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 800);
      try {
        navigator.vibrate?.(50);
      } catch {}
      onLongPress(e);
    }, 500);
  });

  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
      cancel();
    }
  });

  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);

  el.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (onClick) onClick(e);
  });

  el.addEventListener('contextmenu', (e) => {
    if (suppressClick) {
      e.preventDefault();
    }
  });
}

// 今の一覧を、スクロール位置を保ったまま読み直す
function refreshFiler() {
  scrollPositions.set(filerKey, window.scrollY);
  filerKey = null;
  if (markedKind) openMarked(markedKind);
  else if (showingUpdated) openUpdated();
  else if (showingHistory) openHistory();
  else if (searchQuery !== null) openSearch(searchQuery, searchSeries);
  else openFiler(filerPath ?? '');
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
  if (searchQuery) backToSearch = searchRoute(searchQuery, searchSeries);
  else if (!currentFile) backToSearch = null;
  $('.back', menuEl).textContent = backToSearch ? '‹ 検索' : '‹ フォルダ';
  if (filerKey !== null) scrollPositions.set(filerKey, window.scrollY);
  filerKey = null;
  filerPath = null;
  markedKind = null;
  showingUpdated = false;
  showingHistory = false;
  searchQuery = null;
  filerEl.hidden = true;
  readerEl.hidden = false;
  currentFile = path;
  $('.title', menuEl).textContent = displayName(path);
  $('.series', menuEl).textContent = seriesOf(path) ?? '';
  $('.menu-marks', menuEl).replaceChildren(...markButtons(path));
  document.title = displayName(path);
  siblings = fetchList(dirname(path));
  const next = siblings.then((list) => nextEpisodeIn(list, path));
  const prev = siblings.then((list) => prevEpisodeIn(list, path));
  const initialPage = pendingInitialPage;
  pendingInitialPage = null;
  try {
    const { fromCache } = await reader.open(path, settings, { nextPromise: next, prevPromise: prev, initialPage });
    if (pendingJump?.path === path && currentFile === path) reader.jumpTo(pendingJump.line, pendingJump.query);
    pendingJump = null;
    if (fromCache) toast('つながらないため、保存済みの本文を表示しています');
  } catch (e) {
    if (currentFile !== path) return;
    store.deletePosition(path);
    toast(`読み込めませんでした: ${e.message}`);
    location.replace(dirRoute(dirname(path)));
  }
}

function prevEpisodeIn(list, path) {
  const files = sortedFiles(list);
  const i = files.findIndex((f) => childPath(list.path, f.name) === path);
  const f = i > 0 ? files[i - 1] : null;
  return f ? { name: displayName(f.name), path: childPath(list.path, f.name), href: fileRoute(childPath(list.path, f.name)) } : null;
}

function nextEpisodeIn(list, path) {
  const files = sortedFiles(list);
  const i = files.findIndex((f) => childPath(list.path, f.name) === path);
  const f = i >= 0 ? files[i + 1] : null;
  return f ? { name: displayName(f.name), path: childPath(list.path, f.name), href: fileRoute(childPath(list.path, f.name)) } : null;
}

// フォルダを読み直して、目次と前後の話を新しい話に追いつかせる
async function reloadSiblings() {
  const path = currentFile;
  siblings = fetchList(dirname(path));
  const list = await siblings.catch(() => null);
  if (list && currentFile === path) {
    reader.setEpisodes({ next: nextEpisodeIn(list, path), prev: prevEpisodeIn(list, path) });
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
  if (metricsEl) {
    const m = reader.getReadingMetrics?.();
    if (m && m.chars > 0) {
      const remainingPages = pages - 1 - page;
      let timeText = `読了目安 約 ${m.readingMinutes} 分`;
      if (remainingPages === 0 && pages > 1) {
        timeText = '読了';
      } else if (page > 0 && pages > 1) {
        const remainingRatio = remainingPages / pages;
        const remMin = Math.max(1, Math.round(m.readingMinutes * remainingRatio));
        timeText = `読了目安 約 ${m.readingMinutes} 分（残り約 ${remMin} 分）`;
      }
      metricsEl.textContent = `${m.chars.toLocaleString()} 字（原稿用紙 ${m.manuscriptPages} 枚） / ${timeText}`;
    } else {
      metricsEl.textContent = '';
    }
  }
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

// 付箋（推敲メモ）シート
function openNotesSheet(targetLine = null, targetNoteId = null) {
  if (!currentFile) return;
  hideMenu();
  const filePath = currentFile;
  const pathNotes = store.getNotesForPath(filePath);

  let editingNote =
    targetNoteId !== null
      ? pathNotes.find((n) => n.id === targetNoteId)
      : targetLine !== null
        ? pathNotes.find((n) => n.line === targetLine)
        : null;
  let showForm = targetLine !== null || targetNoteId !== null;
  let initialTargetLine = targetLine;

  function renderBody() {
    const items = store.getNotesForPath(filePath);
    const content = [];

    if (showForm) {
      const lineInfo = reader.currentLineInfo();
      const line = editingNote ? editingNote.line : (initialTargetLine ?? lineInfo.line);
      const off = editingNote ? (editingNote.off ?? 0) : (initialTargetLine !== null ? 0 : lineInfo.off);
      const snippet = editingNote ? editingNote.snippet : lineInfo.snippet;

      const textarea = h('textarea', { placeholder: 'メモを入力（空欄でも保存できます）', 'aria-label': 'メモ本文' });
      if (editingNote) textarea.value = editingNote.text;

      const form = h(
        'div',
        { class: 'note-form' },
        h('div', { class: 'note-item-snippet' }, `第 ${line + 1} 行${snippet ? `: ${snippet.slice(0, 30)}…` : ''}`),
        textarea,
        h(
          'div',
          { class: 'note-form-buttons' },
          editingNote
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'delete',
                  onclick: () => {
                    store.deleteNote(editingNote.id);
                    showForm = false;
                    editingNote = null;
                    initialTargetLine = null;
                    reader.markNotes();
                    renderBody();
                  },
                },
                '削除',
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                showForm = false;
                editingNote = null;
                initialTargetLine = null;
                renderBody();
              },
            },
            'キャンセル',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'save',
              onclick: () => {
                const text = textarea.value.trim();
                const existingOnPos = items.find((n) => n.line === line && (n.off ?? 0) === off);
                store.saveNote({
                  id: editingNote?.id ?? existingOnPos?.id,
                  path: filePath,
                  line,
                  off,
                  snippet,
                  text,
                });
                showForm = false;
                editingNote = null;
                initialTargetLine = null;
                reader.markNotes();
                renderBody();
              },
            },
            '保存',
          ),
        ),
      );
      content.push(form);
    } else {
      content.push(
        h(
          'button',
          {
            type: 'button',
            class: 'note-add-btn',
            onclick: () => {
              showForm = true;
              editingNote = null;
              initialTargetLine = null;
              renderBody();
            },
          },
          '＋ このページの位置に付箋を追加',
        ),
      );
    }

    if (!items.length && !showForm) {
      content.push(h('p', { class: 'empty' }, 'この作品の付箋はまだありません'));
    } else {
      for (const note of items) {
        content.push(
          h(
            'div',
            {
              class: 'note-item',
              onclick: () => {
                reader.jumpToNote(note);
                closeSheet();
                hideMenu();
              },
            },
            h(
              'div',
              { class: 'note-item-header' },
              h('span', {}, `第 ${note.line + 1} 行`),
              h('span', {}, updatedText(note.updatedAt)),
            ),
            note.snippet ? h('div', { class: 'note-item-snippet' }, note.snippet) : null,
            note.text ? h('div', { class: 'note-item-text' }, note.text) : null,
            h(
              'div',
              { class: 'note-item-actions' },
              h(
                'button',
                {
                  type: 'button',
                  onclick: (e) => {
                    e.stopPropagation();
                    editingNote = note;
                    showForm = true;
                    renderBody();
                  },
                },
                '編集',
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'delete',
                  onclick: (e) => {
                    e.stopPropagation();
                    store.deleteNote(note.id);
                    if (editingNote?.id === note.id) {
                      editingNote = null;
                      showForm = false;
                    }
                    reader.markNotes();
                    renderBody();
                  },
                },
                '削除',
              ),
            ),
          ),
        );
      }
    }

    openSheet(h('h2', {}, `付箋（推敲メモ）`), h('div', { class: 'notes-view' }, content));
  }

  renderBody();
}

// 差分（ビフォー・アフター）の詳細シート
function openDiffSheet(hunk, hunks = [], index = 0) {
  const deletedText = hunk.deleted?.length ? hunk.deleted.join('\n') : '';
  const addedText = hunk.added?.length ? hunk.added.join('\n') : '';

  const isBaselineMissing = deletedText === '（変更前のテキストは保存されていません）';

  let bChildren;
  let aChildren;

  if (isBaselineMissing) {
    bChildren = [h('span', { class: 'diff-empty' }, deletedText)];
    aChildren = addedText ? [addedText] : [h('span', { class: 'diff-empty' }, '（なし）')];
  } else {
    const { before: bTokens, after: aTokens } = diffChars(deletedText, addedText);
    const renderTokens = (tokens, emptyText = '（なし）') => {
      if (!tokens.length) return [h('span', { class: 'diff-empty' }, emptyText)];
      return tokens.map((t) => {
        if (t.type === 'delete') return h('del', { class: 'diff-del' }, t.text);
        if (t.type === 'insert') return h('ins', { class: 'diff-ins' }, t.text);
        return t.text;
      });
    };
    bChildren = renderTokens(bTokens);
    aChildren = renderTokens(aTokens);
  }

  const nav =
    hunks.length > 1
      ? h(
          'div',
          { class: 'diff-nav' },
          h(
            'button',
            {
              disabled: index >= hunks.length - 1,
              onclick: () => {
                const next = hunks[index + 1];
                reader.jumpTo(next.line);
                openDiffSheet(next, hunks, index + 1);
              },
            },
            '‹ 次の変更',
          ),
          h('span', { class: 'diff-count' }, `${index + 1} / ${hunks.length}`),
          h(
            'button',
            {
              disabled: index <= 0,
              onclick: () => {
                const prev = hunks[index - 1];
                reader.jumpTo(prev.line);
                openDiffSheet(prev, hunks, index - 1);
              },
            },
            '前の変更 ›',
          ),
        )
      : null;

  openSheet(
    h('h2', {}, '変更箇所の差分'),
    nav,
    h(
      'div',
      { class: 'diff-view' },
      h(
        'div',
        { class: 'diff-pane deleted' },
        h('div', { class: 'diff-header' }, '変更前'),
        h('div', { class: 'diff-box' }, h('div', { class: 'diff-text' }, ...bChildren)),
      ),
      h(
        'div',
        { class: 'diff-pane added' },
        h('div', { class: 'diff-header' }, '変更後'),
        h('div', { class: 'diff-box' }, h('div', { class: 'diff-text' }, ...aChildren)),
      ),
    ),
  );
  sheetEl.classList.add('diff');

  requestAnimationFrame(() => {
    const view = $('.diff-view', sheetEl);
    if (view) {
      view.scrollLeft = view.scrollWidth;
    }
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
  if (list?.fromCache) toast('つながらないため、保存済みの目次を表示しています');
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
      options.map(([value, text]) =>
        h('button', { 'aria-pressed': String(settings[key] === value), onclick: () => updateSettings({ [key]: value }) }, text),
      ),
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
    await store.syncWithServer(() => {
      settings = store.loadSettings();
      applyTheme();
      if (!filerEl.hidden) refreshFiler();
    });
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
  onActivate();
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
  navigator.serviceWorker.register('sw.js');
}

applyTheme();
window.addEventListener('hashchange', route);
if (!location.hash) {
  const last = store.getLastRoute();
  if (last) history.replaceState(null, '', last);
}
// 開く話の読書位置を決める前に他の端末の位置を取り込めるよう、画面を開く前に同期を始めておく
store.syncWithServer(() => {
  settings = store.loadSettings();
  applyTheme();
  if (!filerEl.hidden) refreshFiler();
});
route();
