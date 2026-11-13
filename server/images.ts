// 画像を返す。大きい画像は sips で縮小してキャッシュしておく
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IMAGE_CACHE_DIR } from "./config.ts";
import { HttpError, MIME, sendFile } from "./http.ts";

const execFileAsync = promisify(execFile);

// これより大きい画像は縮小して返す（iPhone での表示とオフライン保存を軽くするため）。
// large は挿絵ビューで拡大して見る用。元画像が巨大でも iPhone が重くならない範囲に抑える
export const IMAGE_LIMITS = {
	normal: { bytes: 800 * 1024, pixels: 2000, quality: 82 },
	large: { bytes: 3 * 1024 * 1024, pixels: 4096, quality: 88 },
	icon: { bytes: 64 * 1024, pixels: 192, quality: 85 },
};
type ImageLimit = (typeof IMAGE_LIMITS)[keyof typeof IMAGE_LIMITS];

// 縮小版のキャッシュのキー → 元の画像に透過があるか
const alphaCache = new Map<string, boolean>();

async function hasAlpha(file: string, key: string): Promise<boolean> {
	let alpha = alphaCache.get(key);
	if (alpha === undefined) {
		const { stdout } = await execFileAsync("sips", ["-g", "hasAlpha", file]);
		alpha = /hasAlpha:\s*yes/.test(stdout);
		alphaCache.set(key, alpha);
	}
	return alpha;
}

export async function sendImage(
	req: IncomingMessage,
	res: ServerResponse,
	file: string,
	limit: ImageLimit,
) {
	const st = await stat(file);
	const ext = path.extname(file).toLowerCase();
	if (!MIME[ext]?.startsWith("image/"))
		throw new HttpError(400, "not an image");
	// GIF と SVG は縮小できないので、そのまま返す
	if (st.size <= limit.bytes || ext === ".gif" || ext === ".svg") {
		await sendFile(req, res, file);
		return;
	}
	// 縮小版は元ファイルのパス・サイズ・更新日時と縮小後の大きさをキーにキャッシュする
	const key = createHash("sha1")
		.update(`${file}\0${st.size}\0${st.mtimeMs}\0${limit.pixels}`)
		.digest("hex");
	// PNG のまま縮小すると大きくなるので、透過がなければ JPEG にする
	const outExt =
		ext === ".png" && (await hasAlpha(file, key)) ? ".png" : ".jpg";
	const cached = path.join(IMAGE_CACHE_DIR, key + outExt);
	try {
		await stat(cached);
	} catch {
		await mkdir(IMAGE_CACHE_DIR, { recursive: true });
		const format =
			outExt === ".png"
				? ["png"]
				: ["jpeg", "--setProperty", "formatOptions", String(limit.quality)];
		await execFileAsync("sips", [
			"-Z",
			String(limit.pixels),
			"-s",
			"format",
			...format,
			file,
			"--out",
			cached,
		]);
	}
	await sendFile(req, res, cached);
}
