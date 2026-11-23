// 画像の透過の判定と縮小。macOS は sips、Linux は ffmpeg（ffprobe）を使う。
// どちらも OS に入っているコマンドを呼ぶだけで、画像のライブラリは使わない
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { OS, type Os } from "./platform.ts";

const execFileAsync = promisify(execFile);

type Command = [command: string, args: string[]];

export type ResizeOptions = {
	src: string;
	dest: string;
	// 長辺をこの大きさ（px）までに縮める
	maxPixels: number;
	format: "jpeg" | "png";
	// JPEG の品質（0〜100、大きいほど高品質。sips の formatOptions と同じ尺度）
	quality?: number;
};

// 縮小に失敗したとき、呼び出し側が縮小を諦めて元の画像を使ってよいか。
// macOS は従来どおり失敗をそのまま返し、Linux は ffmpeg が無くても動くよう元の画像に戻させる
export const fallsBackOnError = (os: Os = OS) => os === "linux";

// ffprobe の pix_fmt のうち、アルファチャンネルを持つもの（ffmpeg の libavutil/pixfmt.h より）。
// pal8 はパレットが RGBA なので、透過のない PNG でもこの扱いになるが、透過を失うよりはよいので含める
export const ALPHA_PIX_FMTS: ReadonlySet<string> = new Set([
	"rgba",
	"bgra",
	"argb",
	"abgr",
	"rgba64be",
	"rgba64le",
	"bgra64be",
	"bgra64le",
	"ya8",
	"ya16be",
	"ya16le",
	"gbrap",
	"gbrap10be",
	"gbrap10le",
	"gbrap12be",
	"gbrap12le",
	"gbrap16be",
	"gbrap16le",
	"gbrapf32be",
	"gbrapf32le",
	"yuva420p",
	"yuva422p",
	"yuva444p",
	"yuva420p9be",
	"yuva420p9le",
	"yuva422p9be",
	"yuva422p9le",
	"yuva444p9be",
	"yuva444p9le",
	"yuva420p10be",
	"yuva420p10le",
	"yuva422p10be",
	"yuva422p10le",
	"yuva444p10be",
	"yuva444p10le",
	"yuva422p12be",
	"yuva422p12le",
	"yuva444p12be",
	"yuva444p12le",
	"yuva420p16be",
	"yuva420p16le",
	"yuva422p16be",
	"yuva422p16le",
	"yuva444p16be",
	"yuva444p16le",
	"pal8",
]);

export function hasAlphaCommand(file: string, os: Os = OS): Command {
	if (os === "darwin") return ["sips", ["-g", "hasAlpha", file]];
	return [
		"ffprobe",
		["-v", "error", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file],
	];
}

export function parseHasAlpha(stdout: string, os: Os = OS): boolean {
	if (os === "darwin") return /hasAlpha:\s*yes/.test(stdout);
	return stdout
		.split("\n")
		.some((line) => ALPHA_PIX_FMTS.has(line.trim().toLowerCase()));
}

// JPEG の品質を、ffmpeg の -q:v（2〜31、小さいほど高品質）に換算する。
// 尺度が逆なので、q = round(2 + (100 - 品質) / 6) を 2〜31 に収める（100 → 2、88 → 4、85 → 5、82 → 5）
export function ffmpegJpegQuality(quality: number): number {
	return Math.min(31, Math.max(2, Math.round(2 + (100 - quality) / 6)));
}

export function resizeCommand(options: ResizeOptions, os: Os = OS): Command {
	const { src, dest, maxPixels, format, quality } = options;
	if (os === "darwin") {
		const formatArgs =
			format === "jpeg" && quality !== undefined
				? ["jpeg", "--setProperty", "formatOptions", String(quality)]
				: [format];
		return [
			"sips",
			[
				"-Z",
				String(maxPixels),
				"-s",
				"format",
				...formatArgs,
				src,
				"--out",
				dest,
			],
		];
	}
	// 長辺を maxPixels までに縮める。元が小さければ拡大しない。出力の形式は dest の拡張子で決まる
	const scale = `scale='min(${maxPixels},iw)':'min(${maxPixels},ih)':force_original_aspect_ratio=decrease`;
	return [
		"ffmpeg",
		[
			"-v",
			"error",
			"-y",
			"-i",
			src,
			"-vf",
			scale,
			"-frames:v",
			"1",
			...(format === "jpeg" && quality !== undefined
				? ["-q:v", String(ffmpegJpegQuality(quality))]
				: []),
			dest,
		],
	];
}

export async function hasAlpha(file: string, os: Os = OS): Promise<boolean> {
	const [command, args] = hasAlphaCommand(file, os);
	const { stdout } = await execFileAsync(command, args);
	return parseHasAlpha(stdout, os);
}

export async function resizeImage(
	options: ResizeOptions,
	os: Os = OS,
): Promise<void> {
	const [command, args] = resizeCommand(options, os);
	if (os === "darwin") {
		await execFileAsync(command, args);
		return;
	}
	try {
		await execFileAsync(command, args);
	} catch (e) {
		// 書きかけのファイルが残ると、次からそれを縮小版として返してしまうので消す
		await rm(options.dest, { force: true });
		throw e;
	}
}
