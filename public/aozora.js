// 青空文庫形式のテキストを縦書き表示用の HTML に変換する。
// 1 行の原文を 1 つの <p data-l="行番号"> にする（再開位置の保存に行番号を使うため）。

export function decodeText(buffer) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return new TextDecoder("shift_jis").decode(buffer);
	}
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|heic)$/i;

const EMPHASIS = {
	傍点: "filled sesame",
	白ゴマ傍点: "open sesame",
	丸傍点: "filled circle",
	白丸傍点: "open circle",
	二重丸傍点: "filled double-circle",
	蛇の目傍点: "open double-circle",
	黒三角傍点: "filled triangle",
	白三角傍点: "open triangle",
	ばつ傍点: "'×'",
};

// 縦書きでは over 側が右になるので、傍線は overline で描く
const SIDELINE = {
	傍線: "solid",
	二重傍線: "double",
	鎖線: "dotted",
	破線: "dashed",
	波線: "wavy",
};

const HEADING = {
	大見出し: "h-big",
	中見出し: "h-mid",
	小見出し: "h-small",
};

const SIZE_STEPS = [1, 1.2, 1.4, 1.6, 1.8];

export function escapeHtml(s) {
	return String(s).replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	);
}

const TCY_TAG = '<span class="tcy">';

// 本文の HTML。
// - 縦書きの明朝体では連続したダッシュの間にすき間ができるので、
//   文字は残したまま（読書位置の計算に使う）透明にし、1 本の線を描く
// - 半角の「!」「?」は縦書きで横に倒れるので、縦中横の注記がなくても立てる。
//   2 文字までは 1 文字分に収め、それより長いと潰れるので 1 文字ずつ立てる
// - 1〜2 桁の半角数字も縦中横にする。「Gemini 3.8」「fable5」のように英字や記号と続く数字はそのまま
// 数字は縦中横のタグより先に置き換える（ダッシュのタグの「--n:2」を数字として拾わないため）
export function textHtml(s) {
	return escapeHtml(s)
		.replace(
			/(?<![A-Za-z0-9.,:/_-])[0-9]{1,2}(?![A-Za-z0-9.,:/_-])/g,
			(m) => `${TCY_TAG}${m}</span>`,
		)
		.replace(/[!?]+/g, (m) =>
			m.length <= 2
				? `${TCY_TAG}${m}</span>`
				: `<span class="upright">${m}</span>`,
		)
		.replace(
			/[―—]{2,}/g,
			(m) => `<span class="dash" style="--n:${m.length}">${m}</span>`,
		);
}

// 注記の数字を半角にする。「」で囲まれた本文の引用はそのまま残す
function toHalfDigits(s) {
	return s.replace(/「[^」]*」|[０-９]/g, (c) =>
		c.length === 1 ? String.fromCharCode(c.charCodeAt(0) - 0xfee0) : c,
	);
}

// 範囲指定・前方参照のどちらでも使う、装飾名から開始タグを作る関数
function inlineDecoration(name) {
	if (EMPHASIS[name])
		return `<span class="em" style="text-emphasis:${EMPHASIS[name]};-webkit-text-emphasis:${EMPHASIS[name]}">`;
	if (SIDELINE[name])
		return `<span class="sl" style="text-decoration-style:${SIDELINE[name]}">`;
	// 同行見出し・窓見出しも、ふつうの見出しと同じ見た目にする
	const heading = HEADING[name.replace(/^(同行|窓)/, "")];
	if (heading) return `<span class="${heading}">`;
	if (name === "縦中横") return TCY_TAG;
	if (name === "太字") return "<b>";
	if (name === "斜体") return "<i>";
	if (name === "罫囲み") return '<span class="box">';
	const size = name.match(/^(\d+)段階(大きな|小さな)文字$/);
	if (size) {
		const step = SIZE_STEPS[Math.min(Number(size[1]), SIZE_STEPS.length - 1)];
		const scale = size[2] === "大きな" ? step : 1 / step;
		return `<span style="font-size:${scale.toFixed(3)}em">`;
	}
	return null;
}

function closeTagFor(openTag) {
	return `</${openTag.match(/^<(\w+)/)[1]}>`;
}

// 「〜終わり」で閉じるときに、開始側と対応させるためのキー
function decorationKey(name) {
	return name.replace(/^\d+段階/, "").replace(/^(同行|窓)/, "");
}

// 1 行分の出力を、プレーンテキスト（前方参照の照合用）と HTML の組の列として持つ
class LineBuilder {
	constructor() {
		this.segs = [];
		this.stack = [];
		this.rubyStart = -1;
	}

	text(s) {
		const last = this.segs[this.segs.length - 1];
		if (last && !last.atomic) {
			last.t += s;
			last.h += textHtml(s);
		} else {
			this.segs.push({ t: s, h: textHtml(s), atomic: false });
		}
	}

	atomic(t, h) {
		this.segs.push({ t, h, atomic: true });
	}

	markRubyStart() {
		this.rubyStart = this.segs.length;
		// 次の文字を新しいセグメントにするため、空の区切りを入れておく
		this.segs.push({ t: "", h: "", atomic: true });
	}

	ruby(rt) {
		const rtHtml = `<rt>${escapeHtml(rt)}</rt>`;
		if (this.rubyStart >= 0) {
			const base = this.segs.splice(this.rubyStart);
			this.rubyStart = -1;
			const t = base.map((s) => s.t).join("");
			if (t) {
				this.atomic(
					t,
					`<ruby>${base.map((s) => s.h).join("")}${rtHtml}</ruby>`,
				);
				return;
			}
		}
		const last = this.segs[this.segs.length - 1];
		if (last && !last.atomic) {
			const m =
				last.t.match(/[\p{Script=Han}々〆〇ヵヶ]+$/u) ||
				// oxlint-disable-next-line no-misleading-character-class -- 濁点・半濁点の結合文字（U+3099 / U+309A）も 1 文字として拾うため
				last.t.match(/[\p{Script=Katakana}ー\u3099\u309A]+$/u) ||
				last.t.match(/[A-Za-zＡ-Ｚａ-ｚ0-9０-９]+$/);
			if (m) {
				const head = last.t.slice(0, last.t.length - m[0].length);
				this.segs.pop();
				if (head) this.text(head);
				this.atomic(m[0], `<ruby>${escapeHtml(m[0])}${rtHtml}</ruby>`);
				return;
			}
		}
		this.text(`《${rt}》`);
	}

	open(name, tag) {
		this.stack.push({ key: decorationKey(name), tag, index: this.segs.length });
		this.segs.push({ t: "", h: "", atomic: true });
	}

	close(name) {
		const key = decorationKey(name);
		for (let i = this.stack.length - 1; i >= 0; i--) {
			if (this.stack[i].key === key) {
				const [entry] = this.stack.splice(i, 1);
				this.wrapFrom(entry.index, entry.tag);
				return;
			}
		}
	}

	wrapFrom(index, tag) {
		const inner = this.segs.splice(index);
		const text = inner.map((s) => s.t).join("");
		// 縦中横の中身は 1 文字分に収める文字列なので、自動で立てた「!?」などの装飾は外す
		const innerHtml =
			tag === TCY_TAG ? escapeHtml(text) : inner.map((s) => s.h).join("");
		this.atomic(text, tag + innerHtml + closeTagFor(tag));
	}

	// ［＃「X」に傍点］のような前方参照で、直前の X を包む
	wrapTrailing(target, tag) {
		let acc = "";
		let i = this.segs.length;
		while (i > 0 && acc.length < target.length) {
			i--;
			acc = this.segs[i].t + acc;
		}
		if (!acc.endsWith(target)) return false;
		const extra = acc.length - target.length;
		if (extra > 0) {
			const seg = this.segs[i];
			if (seg.atomic) return false;
			const head = seg.t.slice(0, extra);
			const tail = seg.t.slice(extra);
			this.segs.splice(
				i,
				1,
				{ t: head, h: textHtml(head), atomic: false },
				{ t: tail, h: textHtml(tail), atomic: false },
			);
			i++;
		}
		this.wrapFrom(i, tag);
		return true;
	}

	html() {
		// 閉じ忘れの装飾は行末で閉じる
		while (this.stack.length) {
			const entry = this.stack.pop();
			this.wrapFrom(entry.index, entry.tag);
		}
		return this.segs.map((s) => s.h).join("");
	}
}

// 青空文庫の冒頭にある「テキスト中に現れる記号について」の説明ブロックを取り除く
function stripAozoraHeaderNotes(lines) {
	const limit = Math.min(lines.length, 60);
	for (let i = 0; i < limit; i++) {
		if (!/^-{10,}$/.test(lines[i])) continue;
		if (
			!lines
				.slice(i + 1, i + 4)
				.some((l) => l.includes("テキスト中に現れる記号について"))
		)
			continue;
		for (let j = i + 1; j < lines.length; j++) {
			if (/^-{10,}$/.test(lines[j])) {
				return [...lines.slice(0, i), ...lines.slice(j + 1)];
			}
		}
	}
	return lines;
}

function parseGaiji(body) {
	const u = body.match(/U\+([0-9A-Fa-f]{4,6})/);
	if (u) return { text: String.fromCodePoint(parseInt(u[1], 16)) };
	const desc = body.match(/^「([^」]+)」/);
	return {
		text: "〓",
		html: `<span class="gaiji">［${escapeHtml(desc ? desc[1] : body)}］</span>`,
	};
}

function parseImage(body) {
	const m = body.match(/（([^、）]+)(?:、[^）]*)?）入る$/);
	if (m && IMAGE_EXT.test(m[1])) return m[1];
	return null;
}

// 1 行を解析して、HTML と行単位の指定（字下げ・地付き・挿絵など）を返す
function parseLine(line) {
	let b = new LineBuilder();
	const result = {
		indent: null,
		align: null,
		split: false,
		images: [],
		pageBreak: false,
		blockNotes: [],
	};
	const token =
		/※［＃([^］]*)］|［＃([^］]*)］|｜|《《([^》]*)》》|《([^》]*)》/g;
	let pos = 0;
	let m;
	while ((m = token.exec(line))) {
		if (m.index > pos) b.text(line.slice(pos, m.index));
		pos = token.lastIndex;
		const atLineStart = b.segs.every((s) => s.t === "");

		if (m[1] !== undefined) {
			const g = parseGaiji(m[1]);
			if (g.html) b.atomic(g.text, g.html);
			else b.text(g.text);
		} else if (m[2] !== undefined) {
			handleNote(b, toHalfDigits(m[2]), result, atLineStart);
			// 行の途中の地付きは、そこから後ろを行末に寄せる
			if (result.split && result.before === undefined) {
				result.before = b.html();
				b = new LineBuilder();
			}
		} else if (m[0] === "｜") {
			b.markRubyStart();
		} else if (m[3] !== undefined) {
			b.open("傍点", inlineDecoration("傍点"));
			b.text(m[3]);
			b.close("傍点");
		} else {
			b.ruby(m[4]);
		}
	}
	if (pos < line.length) b.text(line.slice(pos));

	const empty = b.segs.every((s) => s.t === "" && s.h === "");
	if (result.before !== undefined) {
		result.html = `<span>${result.before}</span><span>${b.html()}</span>`;
		result.empty = false;
	} else {
		result.html = b.html();
		result.empty = empty;
	}
	return result;
}

function handleNote(b, body, result, atLineStart) {
	const image = parseImage(body);
	if (image) {
		result.images.push(image);
		return;
	}
	if (/^(改ページ|改丁|改段|改見開き)$/.test(body)) {
		result.pageBreak = true;
		return;
	}
	if (/^(ここから|ここで)/.test(body)) {
		result.blockNotes.push(body);
		return;
	}

	const forward = body.match(/^「(.+)」(?:は|に)(.+)$/);
	if (forward) {
		const [, target, directive] = forward;
		const ruby = directive.match(/^「(.+)」のルビ$/);
		if (ruby && b.wrapTrailing(target, "<ruby>")) {
			const last = b.segs[b.segs.length - 1];
			last.h = last.h.replace(
				/<\/ruby>$/,
				`<rt>${escapeHtml(ruby[1])}</rt></ruby>`,
			);
			return;
		}
		const tag = inlineDecoration(directive);
		if (tag) b.wrapTrailing(target, tag);
		return;
	}

	const indent = body.match(/^(?:天から)?(\d+)字下げ$/);
	if (indent) {
		result.indent = { start: Number(indent[1]), wrap: Number(indent[1]) };
		return;
	}
	const raise = body.match(/^地(?:付き|から(\d+)字上げ)$/);
	if (raise) {
		result.align = { end: raise[1] ? Number(raise[1]) : 0 };
		if (!atLineStart) result.split = true;
		return;
	}

	const end = body.match(/^(.+)終わり$/);
	if (end) {
		b.close(end[1]);
		return;
	}
	const tag = inlineDecoration(body);
	if (tag) b.open(body, tag);
	// それ以外の注記（校正注記など）は表示しない
}

function parseBlockNote(body, block) {
	let m;
	if ((m = body.match(/^ここから(\d+)字下げ(?:、折り返して(\d+)字下げ)?$/))) {
		block.indent = {
			start: Number(m[1]),
			wrap: m[2] ? Number(m[2]) : Number(m[1]),
		};
	} else if ((m = body.match(/^ここから改行天付き、折り返して(\d+)字下げ$/))) {
		block.indent = { start: 0, wrap: Number(m[1]) };
	} else if ((m = body.match(/^ここから地(?:付き|から(\d+)字上げ)$/))) {
		block.align = { end: m[1] ? Number(m[1]) : 0 };
	} else if (/^ここで(字下げ)終わり$/.test(body)) {
		block.indent = null;
	} else if (/^ここで(地付き|字上げ)終わり$/.test(body)) {
		block.align = null;
	} else if ((m = body.match(/^ここから(.+)$/))) {
		const tag = inlineDecoration(m[1]);
		if (tag) block.decorations.push({ key: decorationKey(m[1]), tag });
	} else if ((m = body.match(/^ここで(.+)終わり$/))) {
		const key = decorationKey(m[1]);
		const i = block.decorations.findLastIndex((d) => d.key === key);
		if (i >= 0) block.decorations.splice(i, 1);
	}
}

function lineStyle(indent, align) {
	const styles = [];
	if (indent) {
		styles.push(`padding-inline-start:${indent.wrap}em`);
		if (indent.start !== indent.wrap)
			styles.push(`text-indent:${indent.start - indent.wrap}em`);
	}
	if (align) {
		styles.push("text-align:end");
		if (align.end) styles.push(`padding-inline-end:${align.end}em`);
	}
	return styles.length ? ` style="${styles.join(";")}"` : "";
}

// 本文を行に分ける。表示の行番号（data-l）・変更箇所の比較・検索はすべてこの行番号を使う
export function sourceLines(source) {
	return stripAozoraHeaderNotes(
		source
			.replace(/^\uFEFF/, "")
			.replace(/\r\n?/g, "\n")
			.split("\n"),
	);
}

// 検索用に、ルビの読み・注記・ルビの区切りを除いた 1 行の文字列にする。
// 表示と同じく、直前にルビを付けられる文字がない《》（「……《ファイアボール》」など）は本文として残す
const RUBY_BASE_CHAR =
	// oxlint-disable-next-line no-misleading-character-class -- 濁点・半濁点の結合文字（U+3099 / U+309A）も 1 文字として拾うため
	/[\p{Script=Han}々〆〇ヵヶ\p{Script=Katakana}ー\u3099\u309AA-Za-zＡ-Ｚａ-ｚ0-9０-９]/u;

export function plainLine(line) {
	return line
		.replace(/※?［＃[^］]*］/g, "")
		.replace(/《《([^》]*)》》/g, "$1")
		.replace(/｜([^｜《]*)《[^》]*》/g, "$1")
		.replace(/《[^》]*》/g, (m, offset, str) =>
			offset > 0 && RUBY_BASE_CHAR.test(str[offset - 1]) ? "" : m,
		)
		.replace(/｜/g, "");
}

// 本文の文字数を数える。ルビの読み・注記・空白・改行は除く
export function countAozoraCharacters(source) {
	if (!source) return 0;
	let count = 0;
	for (const line of sourceLines(source))
		count += [...plainLine(line).replace(/\s+/g, "")].length;
	return count;
}

// 文字数・400字詰原稿用紙換算枚数・読了目安時間（約500字/分）を計算する
export function calculateReadingMetrics(source) {
	const chars = countAozoraCharacters(source);
	const manuscriptPages = Math.ceil(chars / 400);
	const readingMinutes = chars > 0 ? Math.max(1, Math.round(chars / 500)) : 0;
	return { chars, manuscriptPages, readingMinutes };
}

// resolveImage(相対パス) は挿絵の表示用の URL を返す関数
export function parseAozora(source, resolveImage = (p) => p) {
	const lines = sourceLines(source);
	const block = { indent: null, align: null, decorations: [] };
	const out = [];

	lines.forEach((line, i) => {
		const r = parseLine(line);
		for (const note of r.blockNotes) parseBlockNote(note, block);
		if (r.pageBreak) out.push('<div class="pb"></div>');

		const onlyNotes =
			r.empty &&
			(r.blockNotes.length > 0 || r.pageBreak || r.images.length > 0);
		if (!onlyNotes) {
			const indent = r.indent ?? block.indent;
			const align = r.split ? null : (r.align ?? block.align);
			let inner = r.empty ? "<br>" : r.html;
			for (const d of [...block.decorations].reverse())
				inner = d.tag + inner + closeTagFor(d.tag);
			out.push(
				`<p data-l="${i}"${r.split ? ' class="split"' : ""}${lineStyle(indent, align)}>${inner}</p>`,
			);
		}
		for (const src of r.images) {
			// 段組みでページをまたいで分割されないよう、枠で包まず画像そのものをブロックにする
			out.push(
				`<img class="fig" data-l="${i}" src="${escapeHtml(resolveImage(src))}" alt="">`,
			);
		}
	});

	return out.join("\n");
}
