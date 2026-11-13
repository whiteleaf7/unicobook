// PWA の本体（public/）を、配信用に dist/ へまとめる。
// JavaScript は app.js から 1 ファイルにまとめて圧縮し、Service Worker と CSS も圧縮する。そのほかはそのまま写す
import { build, type BuildOptions } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "public");
const OUT = path.join(ROOT, "dist");

const COPIED = [
	"index.html",
	"manifest.webmanifest",
	"fonts",
	"icons",
	"splash",
];

const common: BuildOptions = {
	minify: true,
	legalComments: "none",
	logLevel: "warning",
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const name of COPIED)
	await cp(path.join(SRC, name), path.join(OUT, name), { recursive: true });

await build({
	...common,
	entryPoints: [path.join(SRC, "app.js")],
	bundle: true,
	format: "esm",
	outfile: path.join(OUT, "app.js"),
});

// まとめた版では app.js のほかのモジュールがないので、最初に入れるファイルから外させる（sw.js を参照）
await build({
	...common,
	entryPoints: [path.join(SRC, "sw.js")],
	define: { "globalThis.UNICOBOOK_BUNDLED": "true" },
	outfile: path.join(OUT, "sw.js"),
});

await build({
	...common,
	entryPoints: [path.join(SRC, "style.css")],
	outfile: path.join(OUT, "style.css"),
});

console.log(`built: ${path.relative(ROOT, OUT)}/`);
