// サーバーの設定。環境変数（またはリポジトリ直下の .env）で変える。.env.example を参照
import "./env.ts";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defaultDirs, OS } from "./platform.ts";

const env = (name: string) => process.env[name]?.trim() || undefined;
// ~ で始まるパスは、ホームディレクトリからのパスとして扱う
const expandHome = (p: string) =>
	p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
const envPath = (name: string, fallback: string) =>
	path.resolve(expandHome(env(name) ?? fallback));

if (!env("UNICOBOOK_ROOT")) {
	console.error(
		"UNICOBOOK_ROOT に配信する小説フォルダを指定してください（.env.example を参照）",
	);
	process.exit(1);
}

// 配信する小説フォルダの実パス（シンボリックリンクをたどったもの）
export const ROOT = await realpath(envPath("UNICOBOOK_ROOT", ""));
export const PORT = Number(env("UNICOBOOK_PORT") ?? 8787);
// 開発モード（UNICOBOOK_DEV=1）では public/ をビルドせずにそのまま配信し、ふだんは pnpm build で作った dist/ を配信する
export const DEV_MODE = env("UNICOBOOK_DEV") === "1";
export const PUBLIC_DIR = path.resolve(
	import.meta.dirname,
	DEV_MODE ? "../public" : "../dist",
);
if (!existsSync(path.join(PUBLIC_DIR, "index.html"))) {
	console.error(
		"dist/ がありません。pnpm install と pnpm build を実行してください（開発するときは UNICOBOOK_DEV=1 で public/ を配信できます）",
	);
	process.exit(1);
}
// 作業ファイルとユーザーデータの置き場所の既定値は OS で変わる（macOS は ~/Library の下、Linux は XDG の場所）
const DEFAULT_DIRS = defaultDirs(OS);
// 縮小した画像や、Gemini でアイコンを作るときの作業ファイルを置く場所
export const IMAGE_CACHE_DIR = envPath(
	"UNICOBOOK_CACHE_DIR",
	DEFAULT_DIRS.cacheDir,
);

// サーバーが持つユーザーデータの置き場所。小説フォルダには書き込まないよう、ここに保存する
const DATA_DIR = envPath("UNICOBOOK_DATA_DIR", DEFAULT_DIRS.dataDir);
// アプリで選んだフォルダのアイコン（プリセットと、画像より優先するか）
export const PRESETS_FILE = path.join(DATA_DIR, "icons.json");
// 設定・読書位置・お気に入りなど、ブラウザ間で共有するユーザーデータ
export const STORE_DB_FILE = path.join(DATA_DIR, "store.db");

// フォルダのアイコンやあらすじを作る Antigravity の CLI（サブスクの Gemini を使う）。
// launchd は PATH を読まないので実体のパスで呼ぶ
export const AGY = envPath("UNICOBOOK_AGY", "~/.local/bin/agy");
export const AGY_MODEL =
	env("UNICOBOOK_AGY_MODEL") ?? "gemini-3.8-flash-medium";
// agy を動かす作業フォルダ
export const AGY_WORK_DIR = path.join(IMAGE_CACHE_DIR, "generated");
// agy が会話ごとに作ったファイルを置く場所。Gemini が作った画像もここ（brain/<会話 ID>/）に置かれる
export const AGY_BRAIN_DIR = envPath(
	"UNICOBOOK_AGY_BRAIN_DIR",
	"~/.gemini/antigravity-cli/brain",
);
