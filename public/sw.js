// つながるときは常にサーバーから最新を取り、つながらないときは最後に取得したものを返す。
// サーバーは ETag を返すので、変更がなければ 304 で済み、通信量は小さい。

const CACHE = "unicobook-v1";
// 最初に入れておくファイル。倫明朝（fonts/）は大きいので入れず、表示設定で選んで初めて使われたときに取得してキャッシュする
const SHELL = [
	"./",
	"index.html",
	"style.css",
	"app.js",
	"reader.js",
	"aozora.js",
	"store.js",
	"api.js",
	"viewer.js",
	"presets.js",
	"diff.js",
	"dom.js",
	"long-press.js",
	"markdown.js",
	"manifest.webmanifest",
	"icons/icon-180.png",
	"icons/icon-192.png",
	"icons/icon-512.png",
	"icons/favicon-32.png",
	"icons/favicon-64.png",
	"splash/splash-1179x2556.png",
	"splash/splash-dark-1179x2556.png",
];
const NETWORK_TIMEOUT_MS = 6000;

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

async function fromCache(request) {
	const cached = await caches.match(request, { ignoreVary: true });
	if (!cached) return null;
	const headers = new Headers(cached.headers);
	headers.set("X-From-Cache", "1");
	return new Response(cached.body, {
		status: cached.status,
		statusText: cached.statusText,
		headers,
	});
}

async function networkFirst(request) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
	try {
		const response = await fetch(request, { signal: controller.signal });
		if (response.ok) {
			const cache = await caches.open(CACHE);
			await cache.put(request, response.clone());
		}
		return response;
	} catch (e) {
		const cached = await fromCache(request);
		if (cached) return cached;
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin)
		return;
	// 更新確認やユーザーデータはキャッシュを使わない
	if (url.pathname.endsWith("/api/stat") || url.pathname.endsWith("/api/store"))
		return;
	event.respondWith(networkFirst(event.request));
});
