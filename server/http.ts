// HTTP の応答を組み立てる道具
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

// 投げると、その status とメッセージで応答する
export class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".json": "application/json",
	".txt": "text/plain",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".heic": "image/heic",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

export function sendJson(res: ServerResponse, body: unknown) {
	res.writeHead(200, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body));
}

async function readBody(
	req: IncomingMessage,
	maxLength: number,
): Promise<string> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > maxLength) throw new HttpError(413, "too large");
	}
	return body;
}

// リクエストの本文を JSON として読む。JSON でなければ 400 にする
export async function readJsonBody<T>(
	req: IncomingMessage,
	maxLength = 10_000,
): Promise<T> {
	const body = await readBody(req, maxLength);
	try {
		return JSON.parse(body);
	} catch {
		throw new HttpError(400, "invalid json");
	}
}

// ファイルの更新日時（ミリ秒、整数）
export const mtimeOf = (st: { mtimeMs: number }) => Math.floor(st.mtimeMs);

// ETag で再検証させるので、変更がなければ 304 で済む
export async function sendFile(
	req: IncomingMessage,
	res: ServerResponse,
	file: string,
) {
	const st = await stat(file);
	if (!st.isFile()) throw new HttpError(404, "not found");
	const etag = `"${st.size.toString(16)}-${mtimeOf(st).toString(16)}"`;
	const common = {
		ETag: etag,
		"Cache-Control": "no-cache",
		"X-Mtime": String(mtimeOf(st)),
	};
	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, common);
		res.end();
		return;
	}
	res.writeHead(200, {
		"Content-Type":
			MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
		"Content-Length": String(st.size),
		...common,
	});
	createReadStream(file).pipe(res);
}
