// シリーズの設定資料（全体ロードマップやキャラシート）から、Gemini であらすじと登場人物の一覧を作る
import type { IncomingMessage, ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeText } from "../public/aozora.js";
import { askAgy } from "./agy.ts";
import { relativeToRoot, resolveInRoot } from "./files.ts";
import { HttpError, sendJson } from "./http.ts";
import { getValue, putValue } from "./user-store.ts";

// 設定資料とみなすファイル名。プロットや各話の本文は読まない
const SETTING_FILE =
	/(キャラ|ロードマップ|設定|シート|roadmap|character|profile|setting)/i;
const EXCLUDED_FILE = /(プロット|plot|^[0-9]+[_\-話巻])/i;
// 1 つの資料から読む長さ
const MAX_CHARS_PER_FILE = 30000;

async function findSettingFiles(
	dir: string,
): Promise<{ name: string; fullPath: string }[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter(
			(e) =>
				e.isFile() &&
				!e.name.startsWith(".") &&
				!EXCLUDED_FILE.test(e.name) &&
				SETTING_FILE.test(e.name) &&
				/\.(txt|md)$/i.test(e.name),
		)
		.map((e) => ({ name: e.name, fullPath: path.join(e.parentPath, e.name) }));
}

export async function handleGetSummary(
	res: ServerResponse,
	rel: string | null,
) {
	const dir = await resolveInRoot(rel);
	sendJson(res, {
		summary: getValue("summaries", relativeToRoot(dir)) ?? null,
	});
}

export async function handleGenerateSummary(
	req: IncomingMessage,
	res: ServerResponse,
	rel: string | null,
) {
	const dir = await resolveInRoot(rel);
	const settingFiles = await findSettingFiles(dir);
	if (!settingFiles.length) {
		throw new HttpError(
			400,
			"設定資料が見つかりませんでした（全体ロードマップやキャラシートなど、ファイル名に「ロードマップ」「キャラ」「設定」「シート」等を含む .txt または .md をフォルダ内に置いてください）",
		);
	}

	let documents = "";
	for (const file of settingFiles) {
		const text = decodeText(await readFile(file.fullPath));
		documents += `\n\n--- 資料: ${file.name} ---\n${text.slice(0, MAX_CHARS_PER_FILE)}`;
	}

	const seriesTitle = path.basename(dir) || "作品";
	const prompt = [
		`あなたは小説の編集者です。以下のシリーズ「${seriesTitle}」の設定資料（全体ロードマップやキャラクターシート）から、`,
		"読書や執筆推敲の助けとなる「あらすじ・全体概要」と「主な登場人物一覧」を簡潔な日本語の Markdown 形式でまとめてください。",
		"",
		"## 出力形式",
		"### 【あらすじ・作品概要】",
		"（全体の世界観と主要な物語の導入・流れを 300〜500 字程度で簡潔に）",
		"",
		"### 【主な登場人物】",
		"（主要キャラクターの名前、簡単なプロフィール、特徴、関係性を箇条書きで）",
		"",
		"※注意事項：",
		"- 本文や各話プロットは含まれていません。渡された設定資料のみをもとに整理してください。",
		"- 各話の詳細なネタバレは避け、設定・導入に留めてください。",
		"",
		documents,
	].join("\n");

	const summary = { markdown: await askAgy(prompt), updatedAt: Date.now() };
	putValue("summaries", relativeToRoot(dir), summary);
	sendJson(res, { summary });
}
