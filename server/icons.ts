// フォルダのアイコン。フォルダに置いた画像（icon.png など）か、アプリで選んだプリセットを使う。
// 小説フォルダへの書き込みは、Gemini で作ったアイコンを icon.png として置くときと、前の画像を icon~N.png として残すときだけ
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { generateImageWithAgy } from "./agy.ts";
import { PRESETS_FILE, ROOT } from "./config.ts";
import { relativeToRoot, resolveInRoot } from "./files.ts";
import { HttpError, mtimeOf, readJsonBody, sendJson } from "./http.ts";
import { resizeImage } from "./image-tool.ts";
import { IMAGE_LIMITS, sendImage } from "./images.ts";

// フォルダに置くとそのフォルダのアイコンになる画像
const ICON_FILE = /^icon\.(png|jpe?g|webp|gif|heic)$/i;
// 作ったアイコンで置き換えた、フォルダの前の画像（icon~1.png, icon~2.png, …。番号が大きいほど新しい）
const OLD_ICON_FILE = /^icon~(\d+)\.(png|jpe?g|webp|gif|heic)$/i;
// 作っている間にフォルダの icon.png として置く「仮」のアイコン（scripts/make-placeholder-icon.swift で生成）
const PLACEHOLDER_ICON = await readFile(
	path.resolve(import.meta.dirname, "placeholder-icon.png"),
);

// アプリで選んだアイコンの設定

// プリセットの ID と、フォルダに置いた画像よりプリセットを優先するか
type IconSetting = { preset?: string; preferPreset?: true };

// フォルダの相対パス → アイコンの設定
const iconSettings: Record<string, IconSetting> = {};
try {
	const saved: Record<string, string | IconSetting> = JSON.parse(
		await readFile(PRESETS_FILE, "utf8"),
	);
	// 以前はプリセットの ID だけを保存していた
	for (const [key, value] of Object.entries(saved))
		iconSettings[key] = typeof value === "string" ? { preset: value } : value;
} catch {
	// まだ選んでいない
}

// 設定を変えて保存する。項目がなくなったら、そのフォルダの設定ごと消す
async function saveIconSetting(key: string, setting: IconSetting) {
	if (Object.keys(setting).length) iconSettings[key] = setting;
	else delete iconSettings[key];
	await mkdir(path.dirname(PRESETS_FILE), { recursive: true });
	const tmp = `${PRESETS_FILE}.tmp`;
	await writeFile(tmp, JSON.stringify(iconSettings, null, 2));
	await rename(tmp, PRESETS_FILE);
}

// アイコンを付けられるフォルダ（小説フォルダそのものは除く）
async function iconFolder(rel: string | null): Promise<string> {
	const dir = await resolveInRoot(rel);
	if (!(await stat(dir)).isDirectory() || dir === ROOT)
		throw new HttpError(400, "not a folder");
	return dir;
}

// 送られてきた項目だけを変える。preset は null なら選択を外す
export async function handlePreset(
	req: IncomingMessage,
	res: ServerResponse,
	rel: string | null,
) {
	const dir = await iconFolder(rel);
	const { preset, preferPreset } = await readJsonBody<{
		preset?: unknown;
		preferPreset?: unknown;
	}>(req);
	const key = relativeToRoot(dir);
	const setting: IconSetting = { ...iconSettings[key] };
	if (preset === null) delete setting.preset;
	else if (typeof preset === "string" && /^[a-z0-9-]+$/.test(preset))
		setting.preset = preset;
	else if (preset !== undefined) throw new HttpError(400, "invalid preset");
	if (preferPreset === true) setting.preferPreset = true;
	else if (preferPreset === false) delete setting.preferPreset;
	else if (preferPreset !== undefined)
		throw new HttpError(400, "invalid preferPreset");
	await saveIconSetting(key, setting);
	sendJson(res, { ok: true });
}

// 一覧に添えるアイコンの情報

// file はフォルダに置いた画像のファイル名で、version はその更新日時（画像が変わったら読み直させる）。
// preferPreset でなければ、画像をプリセットより優先して表示する。
// generating は Gemini でアイコンを作っている最中、generateError は前回作れなかった理由
export type FolderIcon = IconSetting & {
	file?: string;
	version?: number;
	generating?: true;
	generateError?: string;
};

async function findIconFile(dir: string): Promise<string | null> {
	try {
		return (await readdir(dir)).find((name) => ICON_FILE.test(name)) ?? null;
	} catch {
		return null;
	}
}

// アイコンがなければ null
export async function folderIcon(dir: string): Promise<FolderIcon | null> {
	const key = relativeToRoot(dir);
	const icon: FolderIcon = { ...iconSettings[key] };
	const file = await findIconFile(dir);
	if (file) {
		icon.file = file;
		icon.version = mtimeOf(await stat(path.join(dir, file)));
	}
	const job = iconJobs.get(key);
	if (job?.status === "running") icon.generating = true;
	if (job?.status === "error") icon.generateError = job.error;
	return Object.keys(icon).length ? icon : null;
}

// アイコンのあるシリーズ（小説フォルダ直下のフォルダ）。
// 続きを読むや各一覧で、作品の行にシリーズのアイコンを出すのに使う
export async function seriesIcons(): Promise<Record<string, FolderIcon>> {
	const entries = await readdir(ROOT, { withFileTypes: true });
	const icons: Record<string, FolderIcon> = {};
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith(".")) continue;
		const icon = await folderIcon(path.join(ROOT, e.name));
		if (icon) icons[e.name] = icon;
	}
	return icons;
}

// フォルダに置いた画像を、アイコンの大きさに縮めて返す
export async function handleIcon(
	req: IncomingMessage,
	res: ServerResponse,
	rel: string | null,
) {
	const dir = await resolveInRoot(rel);
	const name = await findIconFile(dir);
	if (!name) throw new HttpError(404, "no icon");
	await sendImage(req, res, path.join(dir, name), IMAGE_LIMITS.icon);
}

// Gemini でアイコンを作る

// フォルダの相対パス → Gemini でアイコンを作っている最中か、作れなかった理由。サーバーを再起動すると忘れる
type IconJob = { status: "running" } | { status: "error"; error: string };
const iconJobs = new Map<string, IconJob>();

// フォルダ名（サブフォルダならシリーズ名から）と追加の指示で、Gemini にアイコンを作ってもらい、フォルダの icon.png にする。
// 1 枚に 2〜3 分かかるので、作り終わるのを待たずに返す。作っている間は「仮」のアイコンを置いておく。
// 前の画像はフォルダに icon~N.png として残し、フォルダの画像を表示したいはずなので、プリセットを優先する設定は外す
export async function handleGenerateIcon(
	req: IncomingMessage,
	res: ServerResponse,
	rel: string | null,
) {
	const dir = await iconFolder(rel);
	const hint = (await readJsonBody<{ hint?: unknown }>(req)).hint ?? "";
	if (typeof hint !== "string" || hint.length > 500)
		throw new HttpError(400, "invalid hint");
	const key = relativeToRoot(dir);
	if (iconJobs.get(key)?.status === "running")
		throw new HttpError(409, "このフォルダのアイコンは作成中です");
	iconJobs.set(key, { status: "running" });
	let replaced: [string, string][];
	try {
		replaced = await moveIconsAway(dir);
		await writeFile(path.join(dir, "icon.png"), PLACEHOLDER_ICON);
	} catch (e) {
		iconJobs.delete(key);
		throw e;
	}
	if (iconSettings[key]?.preferPreset) {
		const { preferPreset, ...rest } = iconSettings[key];
		await saveIconSetting(key, rest);
	}
	generateIcon(
		dir,
		key.split(path.sep).join(" / "),
		hint.trim(),
		replaced,
	).then(
		() => iconJobs.delete(key),
		(e) => {
			console.error(e);
			iconJobs.set(key, { status: "error", error: e.message });
		},
	);
	sendJson(res, { ok: true });
}

// フォルダの画像を、いちばん新しい履歴の次の番号の icon~N.png にし、[元の場所, 移した先] を返す
async function moveIconsAway(dir: string): Promise<[string, string][]> {
	const files = await readdir(dir);
	let last = Math.max(
		0,
		...files.map((name) => Number(OLD_ICON_FILE.exec(name)?.[1] ?? 0)),
	);
	const moved: [string, string][] = [];
	for (const name of files.filter((name) => ICON_FILE.test(name))) {
		const from = path.join(dir, name);
		const to = path.join(dir, `icon~${++last}${path.extname(name)}`);
		await rename(from, to);
		moved.push([from, to]);
	}
	return moved;
}

async function isPlaceholder(file: string): Promise<boolean> {
	return (
		(await readFile(file).catch(() => null))?.equals(PLACEHOLDER_ICON) ?? false
	);
}

async function generateIcon(
	dir: string,
	title: string,
	hint: string,
	replaced: [string, string][],
) {
	const icon = path.join(dir, "icon.png");
	const prompt = [
		`Generate an image: a minimal logo mark for a Japanese novel series titled "${title}", used as a tiny list icon (about 40px).`,
		"One single, simple symbol in flat vector style: thick shapes, 2-3 colors, no gradients, no fine details, no scenery.",
		"Make the symbol large and centered, filling about 85% of the square canvas with only a small margin.",
		"Plain solid-color background that fills the whole canvas: no patterns, stars or textures, no rounded-square frame, no border, no shadow, no text.",
		hint ? `Additional instructions (these take priority): ${hint}` : "",
		// 手元のツールを探したり、サンドボックスの外へ画像を書き出そうとしたりして手数（＝トークン）が増えるので、
		// サブエージェントを呼んで待つだけにさせる。形式の変換や置き場所はサーバー側で面倒を見る。
		// また、サブエージェントの完了を待たずに返事をして終わることがあるので、作り終えるまで待たせる
		"Call the image-generator subagent right away. Do not look for local tools or write any code.",
		"This is a one-shot non-interactive run: you cannot be notified later, so wait for the subagent to finish in this turn.",
		"Do not convert, copy or move the generated image. Reply with only the absolute path of the image file as generated.",
	]
		.filter(Boolean)
		.join("\n");
	try {
		const generated = await generateImageWithAgy(prompt);
		// 作っている間に icon.png が差し替えられていたら、そちらを残す
		if (!(await isPlaceholder(icon))) return;
		const tmp = path.join(dir, ".icon-generating.png");
		await resizeImage({
			src: generated,
			dest: tmp,
			maxPixels: 512,
			format: "png",
		});
		await rename(tmp, icon);
	} catch (e) {
		// 作れなかったら、仮のアイコンを外して前の画像を戻す
		if (await isPlaceholder(icon)) {
			await unlink(icon);
			for (const [from, to] of replaced) await rename(to, from);
		}
		throw e;
	}
}
