// 小説フォルダ（UNICOBOOK_ROOT）を配信し、PWA 本体も配信するサーバー。
// 127.0.0.1 だけで待ち受け、外からは `tailscale serve` 経由でアクセスする。

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { decodeText, plainLine, sourceLines } from "../public/aozora.js";
import { DEV_MODE, PORT, PUBLIC_DIR, ROOT } from "./config.ts";
import {
	isTextFile,
	relativeToRoot,
	resolveInRoot,
	textFilesUnder,
	withMtimes,
	type TextFile,
} from "./files.ts";
import { rejectReason } from "./guard.ts";
import {
	HttpError,
	mtimeOf,
	readJsonBody,
	sendFile,
	sendJson,
} from "./http.ts";
import {
	folderIcon,
	handleGenerateIcon,
	handleIcon,
	handlePreset,
	seriesIcons,
	type FolderIcon,
} from "./icons.ts";
import { IMAGE_LIMITS, sendImage } from "./images.ts";
import { handleGenerateSummary, handleGetSummary } from "./summary.ts";
import * as userStore from "./user-store.ts";

const ROOT_NAME = path.basename(ROOT);

// ユーザーデータ

async function handlePostStore(req: IncomingMessage, res: ServerResponse) {
	const patch = await readJsonBody<unknown>(req, 10_000_000);
	if (!patch || typeof patch !== "object")
		throw new HttpError(400, "invalid body");
	userStore.applyPatch(patch as Record<string, unknown>);
	sendJson(res, { ok: true });
}

function requirePath(rel: string | null): string {
	if (!rel) throw new HttpError(400, "missing path");
	return rel;
}

// 消えたファイルの読書位置を消す
async function cleanNonExistentPositions() {
	try {
		const existing = new Set(await textFilesUnder(ROOT));
		const missing = userStore
			.keysOf("positions")
			.filter((p) => !existing.has(p));
		if (!missing.length) return;
		userStore.deleteValues("positions", missing);
		console.log(`Cleaned ${missing.length} non-existent positions:`, missing);
	} catch (e) {
		console.error("Failed to clean non-existent positions:", e);
	}
}

// 一覧

// フォルダの中身。フォルダには、中の話の数と読了数、読んだあとに更新された話があるか
// （読書位置は iPhone にあるのでアプリで数える）を出すため、下のテキストファイルを更新日時つきで添える
async function handleList(res: ServerResponse, rel: string | null) {
	const dir = await resolveInRoot(rel);
	const entries = await readdir(dir, { withFileTypes: true });
	const dirs: { name: string; icon: FolderIcon | null; texts: TextFile[] }[] =
		[];
	const files: { name: string; size: number; mtime: number }[] = [];
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			dirs.push({
				name: e.name,
				icon: await folderIcon(full),
				texts: await withMtimes(await textFilesUnder(full)),
			});
		} else if (isTextFile(e.name)) {
			const st = await stat(full);
			files.push({ name: e.name, size: st.size, mtime: mtimeOf(st) });
		}
	}
	sendJson(res, {
		root: ROOT_NAME,
		path: relativeToRoot(dir),
		dirs,
		files,
		seriesIcons: await seriesIcons(),
	});
}

// 続きを読む・履歴・印の一覧・検索結果のように、アプリが覚えているパスから描く一覧で更新の印を付けるため、
// 送られてきたパスごとに、ファイルならそれ自身、フォルダなら下（サブフォルダも含む）のテキストファイルを更新日時つきで返す。
// 消えたパスは返さない
async function handleTexts(req: IncomingMessage, res: ServerResponse) {
	const { paths } = await readJsonBody<{ paths?: unknown }>(req, 200_000);
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string"))
		throw new HttpError(400, "invalid paths");
	const texts: Record<string, TextFile[]> = {};
	for (const rel of paths as string[]) {
		const real = await resolveInRoot(rel).catch(() => null);
		if (!real) continue;
		const st = await stat(real);
		if (st.isDirectory())
			texts[rel] = await withMtimes(await textFilesUnder(real));
		else if (st.isFile()) texts[rel] = [{ path: rel, mtime: mtimeOf(st) }];
	}
	sendJson(res, { texts });
}

// フォルダを横断して、更新日時が新しい順にテキストファイルを返す
async function handleRecent(res: ServerResponse, limit: number) {
	const files = (await withMtimes(await textFilesUnder(ROOT))).sort(
		(a, b) => b.mtime - a.mtime,
	);
	sendJson(res, {
		root: ROOT_NAME,
		files: files.slice(0, limit),
		seriesIcons: await seriesIcons(),
	});
}

// 横断検索

// テキストファイルを検索用の行に分けたもの。更新日時が変わるまで使い回す
const searchCache = new Map<string, { mtime: number; lines: string[] }>();

async function searchLines(rel: string): Promise<string[]> {
	const file = path.join(ROOT, rel);
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
async function handleSearch(
	res: ServerResponse,
	q: string,
	rel: string | null,
) {
	const query = q.trim().toLowerCase();
	if (!query) throw new HttpError(400, "empty query");
	const dir = rel ? await resolveInRoot(rel) : ROOT;
	if (!(await stat(dir)).isDirectory())
		throw new HttpError(400, "not a directory");
	const files = (await textFilesUnder(dir)).sort((a, b) =>
		a.localeCompare(b, "ja", { numeric: true }),
	);
	const results: { path: string; line: number; snippet: string; at: number }[] =
		[];
	let truncated = false;
	for (const file of files) {
		const lines = await searchLines(file);
		let inFile = 0;
		for (let i = 0; i < lines.length && inFile < SEARCH_PER_FILE; i++) {
			const at = lines[i].toLowerCase().indexOf(query);
			if (at < 0) continue;
			// 見つかった言葉の前後を少し添える
			const from = Math.max(0, at - 20);
			results.push({
				path: file,
				line: i,
				snippet: lines[i].slice(from, at + query.length + 30),
				at: at - from,
			});
			inFile++;
		}
		if (results.length >= SEARCH_LIMIT) {
			truncated = true;
			break;
		}
	}
	sendJson(res, {
		root: ROOT_NAME,
		results: results.slice(0, SEARCH_LIMIT),
		truncated,
		seriesIcons: await seriesIcons(),
	});
}

// ファイル

async function handleStat(res: ServerResponse, rel: string | null) {
	const st = await stat(await resolveInRoot(rel));
	sendJson(res, { size: st.size, mtime: mtimeOf(st) });
}

async function handleStatic(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
) {
	const rel =
		pathname === "/"
			? "index.html"
			: decodeURIComponent(pathname).replace(/^\/+/, "");
	const file = path.resolve(PUBLIC_DIR, rel);
	if (!file.startsWith(PUBLIC_DIR + path.sep))
		throw new HttpError(403, "forbidden");
	try {
		await sendFile(req, res, file);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			throw new HttpError(404, "not found");
		throw e;
	}
}

// ルーティング

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => unknown;

// ?path= の値（小説フォルダからの相対パス）
const pathParam = (url: URL) => url.searchParams.get("path");

const POST_ROUTES: Record<string, Handler> = {
	"/api/store": (req, res) => handlePostStore(req, res),
	"/api/preset": (req, res, url) => handlePreset(req, res, pathParam(url)),
	"/api/icon/generate": (req, res, url) =>
		handleGenerateIcon(req, res, pathParam(url)),
	"/api/summary": (req, res, url) =>
		handleGenerateSummary(req, res, pathParam(url)),
	"/api/texts": (req, res) => handleTexts(req, res),
};

// GET と HEAD。どれにも当てはまらなければ、アプリ本体のファイルを返す
const GET_ROUTES: Record<string, Handler> = {
	"/api/store": (req, res) => sendJson(res, userStore.snapshot()),
	"/api/baseline": (req, res, url) =>
		sendJson(res, {
			hashes:
				userStore.getValue("baselines", requirePath(pathParam(url))) ?? null,
		}),
	"/api/baseline-text": (req, res, url) =>
		sendJson(res, {
			text:
				userStore.getValue("baselineTexts", requirePath(pathParam(url))) ??
				null,
		}),
	"/api/summary": (req, res, url) => handleGetSummary(res, pathParam(url)),
	"/api/list": (req, res, url) => handleList(res, pathParam(url)),
	"/api/recent": (req, res, url) =>
		handleRecent(
			res,
			Math.min(Number(url.searchParams.get("limit")) || 30, 200),
		),
	"/api/search": (req, res, url) =>
		handleSearch(res, url.searchParams.get("q") ?? "", pathParam(url)),
	"/api/stat": (req, res, url) => handleStat(res, pathParam(url)),
	"/api/file": async (req, res, url) =>
		sendFile(req, res, await resolveInRoot(pathParam(url))),
	"/api/icon": (req, res, url) => handleIcon(req, res, pathParam(url)),
	"/api/image": async (req, res, url) => {
		const limit =
			url.searchParams.get("size") === "large"
				? IMAGE_LIMITS.large
				: IMAGE_LIMITS.normal;
		await sendImage(req, res, await resolveInRoot(pathParam(url)), limit);
	},
};

function findHandler(method: string | undefined, pathname: string): Handler {
	if (method === "POST" && POST_ROUTES[pathname]) return POST_ROUTES[pathname];
	if (method === "GET" || method === "HEAD")
		return (
			GET_ROUTES[pathname] ??
			((req, res, url) => handleStatic(req, res, url.pathname))
		);
	throw new HttpError(405, "method not allowed");
}

async function route(req: IncomingMessage, res: ServerResponse) {
	const rejected = rejectReason(req.method, req.headers);
	if (rejected) throw new HttpError(403, rejected);
	const url = new URL(req.url ?? "/", "http://localhost");
	await findHandler(req.method, url.pathname)(req, res, url);
}

const server = createServer(async (req, res) => {
	try {
		await route(req, res);
	} catch (e) {
		const status = e instanceof HttpError ? e.status : 500;
		if (status === 500) console.error(e);
		if (!res.headersSent)
			res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
		res.end(e instanceof Error ? e.message : "error");
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(
		`unicobook: http://127.0.0.1:${PORT}/ (root: ${ROOT}, app: ${DEV_MODE ? "public/（開発モード）" : "dist/"})`,
	);
	void cleanNonExistentPositions();
});
