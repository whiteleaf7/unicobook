import test from "node:test";
import assert from "node:assert/strict";
import {
	ALPHA_PIX_FMTS,
	fallsBackOnError,
	ffmpegJpegQuality,
	hasAlphaCommand,
	parseHasAlpha,
	resizeCommand,
} from "../server/image-tool.ts";
import { defaultDirs, detectOs } from "../server/platform.ts";

test("OS は linux だけ Linux 扱いで、ほかは macOS と同じ扱いにする", () => {
	assert.equal(detectOs("darwin"), "darwin");
	assert.equal(detectOs("linux"), "linux");
	for (const p of ["win32", "freebsd", "openbsd"])
		assert.equal(detectOs(p), "darwin", p);
});

test("macOS の既定のパスは ~/Library の下", () => {
	// XDG の変数があっても macOS では使わない
	const env = { XDG_CACHE_HOME: "/x/cache", XDG_DATA_HOME: "/x/data" };
	assert.deepEqual(defaultDirs("darwin", env), {
		cacheDir: "~/Library/Caches/unicobook",
		dataDir: "~/Library/Application Support/unicobook",
	});
});

test("Linux の既定のパスは XDG に従う", () => {
	assert.deepEqual(defaultDirs("linux", {}), {
		cacheDir: "~/.cache/unicobook",
		dataDir: "~/.local/share/unicobook",
	});
	assert.deepEqual(
		defaultDirs("linux", {
			XDG_CACHE_HOME: "/home/me/cache",
			XDG_DATA_HOME: " /home/me/data ",
		}),
		{
			cacheDir: "/home/me/cache/unicobook",
			dataDir: "/home/me/data/unicobook",
		},
	);
	// 空や相対パスは、XDG の仕様どおり無視する
	assert.deepEqual(
		defaultDirs("linux", { XDG_CACHE_HOME: "", XDG_DATA_HOME: "rel/data" }),
		{
			cacheDir: "~/.cache/unicobook",
			dataDir: "~/.local/share/unicobook",
		},
	);
});

test("macOS の透過の判定は従来どおり sips -g hasAlpha", () => {
	assert.deepEqual(hasAlphaCommand("/a/b.png", "darwin"), [
		"sips",
		["-g", "hasAlpha", "/a/b.png"],
	]);
	assert.equal(parseHasAlpha("/a/b.png\n  hasAlpha: yes\n", "darwin"), true);
	assert.equal(parseHasAlpha("/a/b.png\n  hasAlpha: no\n", "darwin"), false);
});

test("Linux の透過の判定は ffprobe の pix_fmt で見る", () => {
	assert.deepEqual(hasAlphaCommand("/a/b.png", "linux"), [
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=pix_fmt",
			"-of",
			"csv=p=0",
			"/a/b.png",
		],
	]);
	for (const fmt of [
		"rgba",
		"argb",
		"bgra",
		"abgr",
		"rgba64be",
		"ya8",
		"ya16le",
		"gbrap",
		"yuva420p",
		"yuva444p10le",
		"pal8",
	]) {
		assert.equal(ALPHA_PIX_FMTS.has(fmt), true, fmt);
		assert.equal(parseHasAlpha(`${fmt}\n`, "linux"), true, fmt);
	}
	for (const fmt of [
		"rgb24",
		"bgr24",
		"rgb48be",
		"gray",
		"gray16be",
		"yuv420p",
		"yuvj420p",
		"yuvj444p",
		"gbrp",
		"",
	]) {
		assert.equal(ALPHA_PIX_FMTS.has(fmt), false, fmt);
		assert.equal(parseHasAlpha(`${fmt}\n`, "linux"), false, fmt);
	}
});

test("macOS の縮小は従来と同じ sips のコマンドライン", () => {
	// images.ts の JPEG（品質付き）
	assert.deepEqual(
		resizeCommand(
			{
				src: "/s.png",
				dest: "/c/k.jpg",
				maxPixels: 2000,
				format: "jpeg",
				quality: 82,
			},
			"darwin",
		),
		[
			"sips",
			[
				"-Z",
				"2000",
				"-s",
				"format",
				"jpeg",
				"--setProperty",
				"formatOptions",
				"82",
				"/s.png",
				"--out",
				"/c/k.jpg",
			],
		],
	);
	// images.ts の PNG（品質は付けない）
	assert.deepEqual(
		resizeCommand(
			{
				src: "/s.png",
				dest: "/c/k.png",
				maxPixels: 4096,
				format: "png",
				quality: 88,
			},
			"darwin",
		),
		[
			"sips",
			["-Z", "4096", "-s", "format", "png", "/s.png", "--out", "/c/k.png"],
		],
	);
	// icons.ts のアイコン
	assert.deepEqual(
		resizeCommand(
			{
				src: "/g.jpg",
				dest: "/d/.icon-generating.png",
				maxPixels: 512,
				format: "png",
			},
			"darwin",
		),
		[
			"sips",
			[
				"-Z",
				"512",
				"-s",
				"format",
				"png",
				"/g.jpg",
				"--out",
				"/d/.icon-generating.png",
			],
		],
	);
});

test("Linux の縮小は ffmpeg で、拡大せず長辺を縮める", () => {
	const scale = (px) =>
		`scale='min(${px},iw)':'min(${px},ih)':force_original_aspect_ratio=decrease`;
	assert.deepEqual(
		resizeCommand(
			{
				src: "/s.png",
				dest: "/c/k.jpg",
				maxPixels: 2000,
				format: "jpeg",
				quality: 82,
			},
			"linux",
		),
		[
			"ffmpeg",
			[
				"-v",
				"error",
				"-y",
				"-i",
				"/s.png",
				"-vf",
				scale(2000),
				"-frames:v",
				"1",
				"-q:v",
				"5",
				"/c/k.jpg",
			],
		],
	);
	// PNG には -q:v を付けない
	assert.deepEqual(
		resizeCommand(
			{
				src: "/s.png",
				dest: "/c/k.png",
				maxPixels: 512,
				format: "png",
				quality: 88,
			},
			"linux",
		),
		[
			"ffmpeg",
			[
				"-v",
				"error",
				"-y",
				"-i",
				"/s.png",
				"-vf",
				scale(512),
				"-frames:v",
				"1",
				"/c/k.png",
			],
		],
	);
});

test("JPEG の品質を ffmpeg の -q:v に換算する", () => {
	assert.equal(ffmpegJpegQuality(100), 2);
	assert.equal(ffmpegJpegQuality(88), 4);
	assert.equal(ffmpegJpegQuality(85), 5);
	assert.equal(ffmpegJpegQuality(82), 5);
	assert.equal(ffmpegJpegQuality(50), 10);
	assert.equal(ffmpegJpegQuality(0), 19);
	assert.equal(ffmpegJpegQuality(-1000), 31);
	assert.equal(ffmpegJpegQuality(1000), 2);
	// 品質が高いほど -q:v は小さい（逆の尺度）
	for (let q = 1; q <= 100; q++)
		assert.ok(ffmpegJpegQuality(q) <= ffmpegJpegQuality(q - 1), String(q));
});

test("縮小に失敗したとき元の画像に戻すのは Linux だけ", () => {
	assert.equal(fallsBackOnError("darwin"), false);
	assert.equal(fallsBackOnError("linux"), true);
});
