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
  const { res, fromCache } = await get(`api/list?${q(path)}`);
  return { ...(await res.json()), fromCache };
}

export async function fetchRecentlyUpdated(limit) {
  const { res, fromCache } = await get(`api/recent?limit=${limit}`);
  return { ...(await res.json()), fromCache };
}

// 小説フォルダ全体からの検索。series を渡すと、そのシリーズの中だけを探す
export async function searchAll(query, series = null) {
  const scope = series ? `&${q(series)}` : '';
  const { res, fromCache } = await get(`api/search?q=${encodeURIComponent(query)}${scope}`);
  return { ...(await res.json()), fromCache };
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

// 差分検知用の起点ハッシュ値（前回の各行の指紋）をサーバーから取得する
export async function fetchBaseline(path) {
  try {
    const { res } = await get(`api/baseline?${q(path)}`);
    const data = await res.json();
    return data.hashes ?? null;
  } catch {
    return null;
  }
}

// 差分比較用の起点テキスト（前回の本文全文）をサーバーから取得する
export async function fetchBaselineText(path) {
  try {
    const { res } = await get(`api/baseline-text?${q(path)}`);
    const data = await res.json();
    return data.text ?? null;
  } catch {
    return null;
  }
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

// 設定資料（全体ロードマップやキャラシート）から、Gemini であらすじ・登場人物リストを生成する
export async function fetchSummary(dirPath) {
  const { res } = await get(`api/summary?${q(dirPath)}`);
  return await res.json();
}

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
