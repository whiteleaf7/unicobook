// 画像を返す。大きい画像は縮小してキャッシュしておく（縮小に使うコマンドは image-tool.ts を参照）
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { IMAGE_CACHE_DIR } from "./config.ts";
import { HttpError, MIME, sendFile } from "./http.ts";
import { fallsBackOnError, hasAlpha, resizeImage } from "./image-tool.ts";

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

async function hasAlphaCached(file: string, key: string): Promise<boolean> {
	let alpha = alphaCache.get(key);
	if (alpha === undefined) {
		alpha = await hasAlpha(file);
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
	let cached: string;
	try {
		cached = await resizeCached(file, ext, key, limit);
	} catch (e) {
		// Linux で ffmpeg が無いときなどは、縮小を諦めて元の画像を返す
		if (!fallsBackOnError()) throw e;
		console.error(`画像を縮小できませんでした: ${file}`, e);
		cached = file;
	}
	await sendFile(req, res, cached);
}

// 縮小版を作って（キャッシュにあればそれを使って）、そのパスを返す
async function resizeCached(
	file: string,
	ext: string,
	key: string,
	limit: ImageLimit,
): Promise<string> {
	// PNG のまま縮小すると大きくなるので、透過がなければ JPEG にする
	const outExt =
		ext === ".png" && (await hasAlphaCached(file, key)) ? ".png" : ".jpg";
	const cached = path.join(IMAGE_CACHE_DIR, key + outExt);
	try {
		await stat(cached);
	} catch {
		await mkdir(IMAGE_CACHE_DIR, { recursive: true });
		await resizeImage({
			src: file,
			dest: cached,
			maxPixels: limit.pixels,
			format: outExt === ".png" ? "png" : "jpeg",
			quality: limit.quality,
		});
	}
	return cached;
}
