// Mac 上のサーバーとの通信。Service Worker がキャッシュから返したときは fromCache が true になる

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return { res, fromCache: res.headers.get('X-From-Cache') === '1' };
}

async function post(url, body, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// JSON を返す API。Service Worker がキャッシュから返したかも添える
async function getJson(url) {
  const { res, fromCache } = await get(url);
  return { ...(await res.json()), fromCache };
}

const q = (path) => `path=${encodeURIComponent(path)}`;

// サーバーに保存した設定・読書位置・お気に入りなどのユーザーデータ
export async function fetchStore() {
  const { res } = await get('api/store');
  return res.json();
}

export async function saveStorePatch(patch) {
  return await post('api/store', patch);
}

export async function fetchList(path) {
  return getJson(`api/list?${q(path)}`);
}

export async function fetchRecentlyUpdated(limit) {
  return getJson(`api/recent?limit=${limit}`);
}

// 小説フォルダ全体からの検索。series を渡すと、そのシリーズの中だけを探す
export async function searchAll(query, series = null) {
  const scope = series ? `&${q(series)}` : '';
  return getJson(`api/search?q=${encodeURIComponent(query)}${scope}`);
}

// パスごとの話の更新日時（ファイルならそれ自身、フォルダなら下のテキストファイル）。{ [path]: [{ path, mtime }] }
export async function fetchTexts(paths) {
  return (await post('api/texts', { paths })).texts;
}

export async function fetchText(path) {
  const { res, fromCache } = await get(`api/file?${q(path)}`);
  return { buffer: await res.arrayBuffer(), mtime: Number(res.headers.get('X-Mtime')), fromCache };
}

export async function fetchStat(path) {
  const { res } = await get(`api/stat?${q(path)}`);
  return res.json();
}

// 変更箇所の印の基準にする、前回の本文の行ごとの指紋（ハッシュ値）。取れなければ null
export async function fetchBaseline(path) {
  return (await getJson(`api/baseline?${q(path)}`).catch(() => null))?.hashes ?? null;
}

// 変更箇所の差分を見せるための、前回の本文の全文。取れなければ null
export async function fetchBaselineText(path) {
  return (await getJson(`api/baseline-text?${q(path)}`).catch(() => null))?.text ?? null;
}

export function imageUrl(path) {
  return `api/image?${q(path)}`;
}

// フォルダのアイコンの設定を変える。渡した項目だけを変える。
// preset はプリセットの ID（null なら選択を外す）、preferPreset はフォルダに置いた画像よりプリセットを優先するか
export async function saveIconSetting(dirPath, setting) {
  await post(`api/preset?${q(dirPath)}`, setting);
}

// フォルダ名と追加の指示（hint）で、Gemini にフォルダのアイコン（icon.png）を作ってもらう。
// 作り終わるのを待たずに返り、作っている間はフォルダに「仮」のアイコンが置かれる
export async function generateIcon(dirPath, hint) {
  await post(`api/icon/generate?${q(dirPath)}`, { hint });
}

// 設定資料（全体ロードマップやキャラシート）から Gemini で作った、あらすじ・登場人物リスト
export async function fetchSummary(dirPath) {
  return getJson(`api/summary?${q(dirPath)}`);
}

// あらすじ・登場人物リストを作り直す。作り終わるまで数分かかる
export async function generateSummary(dirPath) {
  return await post(`api/summary?${q(dirPath)}`, {}, { timeoutMs: 240000 });
}

// フォルダに置いた icon.png などのアイコン。version（画像の更新日時）が変われば読み直す
export function iconUrl(dirPath, version) {
  return `api/icon?${q(dirPath)}&v=${version ?? 0}`;
}

// 挿絵ビューで拡大して見るための、縮小を緩めた画像の URL
export function largeImageUrl(src) {
  const url = new URL(src, location.href);
  url.searchParams.set('size', 'large');
  return url.href;
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

// テキストファイルのあるフォルダを基準に、挿絵の相対パスを解決する
export function joinPath(dir, rel) {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
