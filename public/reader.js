// 縦書きのページ表示。本文を CSS の段組みで「ページの高さ = 1 段」に分割し、
// 溢れた段が下に積み重なったものを translateY でずらして 1 ページずつ見せる。

import {
	parseAozora,
	decodeText,
	sourceLines,
	textHtml,
	escapeHtml,
	calculateReadingMetrics,
} from "./aozora.js";
import { fetchText, fetchStat, imageUrl, dirname, joinPath } from "./api.js";
import {
	getPosition,
	setPosition,
	getBaseline,
	setBaseline,
	getBaselineText,
	setBaselineText,
	syncSettled,
	getNotesForPath,
	saveNote,
	deleteNote,
} from "./store.js";
import { changedLines, lineHashes, detailedDiff } from "./diff.js";

// 段と段の間隔。ページの外は切り取るので値に意味はなく、隣の段がはみ出さない程度あればよい
const GAP = 80;
const SNIPPET_LENGTH = 16;
const SEARCH_LIMIT = 300;
// スワイプでめくるときの、指を離したあとのアニメーション
const SLIDE_MS = 180;
// 指を離したとき、画面幅のこの割合以上動かしていればめくる
const COMMIT_RATIO = 0.25;
// これより速く払っていれば、動かした距離が短くてもめくる（px/ms）
const FLICK_VELOCITY = 0.4;
// 変更前の本文がサーバーにないときに、変更前の欄に出す文言
export const BASELINE_MISSING = "（変更前のテキストは保存されていません）";
// 挿絵のダブルタップとみなす間隔
const DOUBLE_TAP_MS = 300;
// 上端の付箋エリアの長押しとみなす時間と、上端からの判定幅（px）
const LONG_PRESS_MS = 500;
const NOTE_AREA_HEIGHT = 48;
// ホイールでめくるのに要る量（px）と、続けてめくるときの最短の間隔
const WHEEL_THRESHOLD = 10;
const WHEEL_INTERVAL_MS = 50;

// ゴシックは明朝より太く見えるので一段細くする。iPhone のヒラギノ角ゴは W3 より細い太さがないので変わらない
export const FONTS = {
	mincho: {
		family: '"Hiragino Mincho ProN", "Yu Mincho", serif',
		weight: "normal",
	},
	rinmincho: {
		family: '"RinMincho", "Hiragino Mincho ProN", "Yu Mincho", serif',
		weight: "normal",
	},
	gothic: {
		family: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif',
		weight: "300",
	},
};

// 倫明朝用の濁点・半濁点の合成。
// 仮名（ひらがな・カタカナ・小書き・踊り字）や長音符に続く濁点・半濁点を、結合用の文字に変換して1字にする
const KANA_DAKUTEN_RE =
	/([\u3041-\u3096\u309D\u309E\u30A1-\u30FA\u30FD\u30FE\u31F0-\u31FF\u30FC])([゛ﾞ゜ﾟ])/g;

export function composeKanaDakuten(str) {
	return str.replace(KANA_DAKUTEN_RE, (_, char, mark) => {
		const combining = mark === "゛" || mark === "ﾞ" ? "\u3099" : "\u309A";
		return char + combining;
	});
}

// ルビの読みを除いた、見えている本文の文字列と、それを構成するテキストノード
function visibleText(el) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const nodes = [];
	let text = "";
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.parentElement.closest("rt")) continue;
		nodes.push({ node: n, start: text.length });
		text += n.data;
	}
	return { text, nodes };
}

function rangeIn(nodes, from, to) {
	const at = (offset, isEnd) => {
		const i = nodes.findLastIndex((n) =>
			isEnd ? n.start < offset : n.start <= offset,
		);
		const { node, start } = nodes[Math.max(i, 0)];
		return [node, Math.min(offset - start, node.length)];
	};
	const range = document.createRange();
	range.setStart(...at(from, false));
	range.setEnd(...at(to, true));
	return range;
}

// 付箋を、保存した読書位置と同じ形にする（locate や pageOf に渡すため）
const notePosition = (note) => ({
	line: note.line,
	off: note.off ?? 0,
	snippet: note.snippet,
});

function vibrate() {
	try {
		navigator.vibrate?.(50);
	} catch {}
}

function textNodes(el) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const nodes = [];
	let start = 0;
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		nodes.push({ node: n, start });
		start += n.length;
	}
	return nodes;
}

export class Reader {
	// canDrag() が false のとき（メニューを開いているときなど）は、スワイプで指に追従させない
	// onImageOpen(src) は挿絵をダブルタップしたときに呼ぶ
	constructor(
		el,
		{
			onTap,
			onChange,
			canDrag,
			onImageOpen,
			onNavigateEpisode,
			onDiffDetail,
			onNoteOpen,
		} = {},
	) {
		this.el = el;
		this.pageEl = el.querySelector(".page");
		this.content = el.querySelector(".content");
		this.statusEl = el.querySelector(".status");
		this.epNavEl = el.querySelector(".ep-nav");
		this.onTap = onTap;
		this.onChange = onChange;
		this.canDrag = canDrag;
		this.onImageOpen = onImageOpen;
		this.onNavigateEpisode = onNavigateEpisode;
		this.onDiffDetail = onDiffDetail;
		this.onNoteOpen = onNoteOpen;
		this.font = "mincho";
		// スワイプ中に隣のページを横に並べて見せるための複製。本文はページを縦に積んでいるので、
		// 横に並べるには別の窓が要る。組み直すたびに作り直す
		this.peekEl = document.createElement("div");
		this.peekEl.className = "page peek";
		this.peekEl.hidden = true;
		this.peekContent = document.createElement("div");
		this.peekContent.className = "content";
		this.peekEl.append(this.peekContent);
		this.peekNotesEl = document.createElement("div");
		this.peekNotesEl.className = "note-marks";
		this.peekEl.append(this.peekNotesEl);
		this.pageEl.after(this.peekEl);
		this.peekDirty = true;
		this.peekTimer = 0;
		this.sliding = false;
		this.saveTimer = null;
		// 変更の印の基準にする本文の指紋。印の × で消すまでは前の基準を保ち、何度開いても同じ変更に印を付ける
		this.baseline = null;
		this.rawText = "";
		this.lines = [];
		this.baselineLines = null;
		// 前回読んだときから変わった箇所（変更のまとまりごとの先頭の行番号）
		this.hashes = [];
		this.changeLines = [];
		this.changeIndex = -1;
		this.changesEl = el.querySelector(".changes");
		const onChangesButton = (selector, action) =>
			this.changesEl.querySelector(selector)?.addEventListener("click", (e) => {
				e.stopPropagation();
				action();
			});
		onChangesButton(".next-change", () => this.nextChange());
		onChangesButton(".diff-detail", () => this.showCurrentDiffDetail());
		onChangesButton(".close-changes", () => this.clearChanges());
		this.changesEl.addEventListener("pointerdown", (e) => e.stopPropagation());
		// マウスで押してもフォーカスを移さない。移すと、続けてキーでページをめくったときにフォーカスの枠が出てしまう
		this.changesEl.addEventListener("mousedown", (e) => e.preventDefault());
		// 検索で見つかった言葉の印。WebKit は縦書きの ::highlight() を描かないので、
		// 言葉の位置に四角を重ねる。本文と同じだけずらすので、本文の要素には手を入れずに済む
		this.marksEl = document.createElement("div");
		this.marksEl.className = "marks";
		this.pageEl.append(this.marksEl);
		this.notesEl = document.createElement("div");
		this.notesEl.className = "note-marks";
		this.pageEl.append(this.notesEl);
		this.suppressNoteClickUntil = 0;
		this.highlightRange = null;
		this.path = null;
		this.mtime = 0;
		this.page = 0;
		this.pages = 1;
		this.stride = 1;
		// 組み直しの基準にする位置。ページをめくったときだけ更新する。
		// 組み直すたびにページ先頭を取り直すと、文字サイズを変えるたびに位置が前へずれていくため
		this.anchor = null;
		// この端末が最後に保存した位置の更新時刻。これより新しい位置が保存されていれば、他の端末で進んだということ
		this.savedAt = 0;
		// 前後の話 { name, path, href }
		this.nextEpisode = null;
		this.prevEpisode = null;
		this.bindGestures();
	}

	// nextPromise / prevPromise は前後の話 { name, path, href } か null を返す Promise
	async open(path, settings, { nextPromise, prevPromise, initialPage } = {}) {
		this.path = path;
		this.content.innerHTML = "";
		this.applyStyle(settings);
		this.baseline = null;
		this.baselineLines = null;
		const [{ buffer, mtime, fromCache }, baselineHashes, next, prev] =
			await Promise.all([
				fetchText(path),
				getBaseline(path).catch(() => null),
				nextPromise?.catch(() => null) ?? null,
				prevPromise?.catch(() => null) ?? null,
				// 他の端末で進んだ位置を取り込んでから、開く位置を決める
				syncSettled(),
			]);
		// 読み込み中に別の画面へ移っていたら何もしない
		if (this.path !== path) return { fromCache };
		this.nextEpisode = next;
		this.prevEpisode = prev;
		this.setText(buffer, mtime);
		if (baselineHashes) {
			this.baseline = baselineHashes;
			this.markChanges();
		} else {
			this.baseline = this.hashes;
			setBaseline(path, this.hashes);
			setBaselineText(path, this.rawText);
		}
		const pos =
			initialPage === "last" || initialPage === "first"
				? null
				: getPosition(path);
		this.relayout(pos);
		if (initialPage === "last") {
			this.go(this.pages - 1, { save: false });
			this.save();
		} else if (initialPage === "first") {
			this.go(0, { save: false });
			this.save();
		}
		// 開いただけでも「最後に開いた日」を更新する。保存済みの位置があればそれを基準のまま残す
		if (this.anchor) this.persist();
		else this.save();
		this.markNotes();
		this.relayoutWhenFontsLoad();
		return { fromCache };
	}

	// 読み込んだファイルの中身を、今の本文にして描く
	setText(buffer, mtime) {
		this.rawText = decodeText(buffer);
		this.lines = sourceLines(this.rawText);
		this.metrics = calculateReadingMetrics(this.rawText);
		this.render(this.rawText, mtime);
	}

	// フォントを読み込んでいる最中なら、読み込み終わってから組み直す（文字の大きさが変わってページがずれるため）
	relayoutWhenFontsLoad() {
		if (document.fonts?.status !== "loading") return;
		const path = this.path;
		void document.fonts.ready.then(() => {
			if (this.path && this.path === path) this.relayout();
		});
	}

	getReadingMetrics() {
		return (
			this.metrics ??
			(this.rawText ? calculateReadingMetrics(this.rawText) : null)
		);
	}

	close() {
		this.flushSave();
		this.path = null;
		this.rawText = null;
		this.metrics = null;
		this.anchor = null;
		this.savedAt = 0;
		this.content.innerHTML = "";
		this.statusEl.textContent = "";
		this.baseline = null;
		this.changeLines = [];
		this.changeIndex = -1;
		this.updateChanges();
		this.setHighlight(null);
		this.notesEl.replaceChildren();
		this.peekNotesEl.replaceChildren();
		this.nextEpisode = null;
		this.prevEpisode = null;
		this.hideNavGuide();
	}

	render(text, mtime) {
		this.hashes = lineHashes(sourceLines(text));
		this.setHighlight(null);
		const dir = dirname(this.path);
		const content = this.font === "rinmincho" ? composeKanaDakuten(text) : text;
		this.content.innerHTML = parseAozora(content, (src) =>
			imageUrl(joinPath(dir, src)),
		);
		this.mtime = mtime;
	}

	// 前後の話を更新する
	setEpisodes({ next, prev } = {}) {
		if (next !== undefined) this.nextEpisode = next;
		if (prev !== undefined) this.prevEpisode = prev;
		this.updateNavGuide();
	}

	// 最後のページでは左下に次の話、最初のページでは右下に前の話のタイトルを出す。
	// 本文と同じ縦書きにし、めくる向きへ動く矢印を添えて、めくれば移れることを見せる
	updateNavGuide() {
		if (!this.epNavEl) return;
		const dir = this.episodeBeyond("next")
			? "next"
			: this.episodeBeyond("prev")
				? "prev"
				: null;
		if (!dir) {
			this.hideNavGuide();
			return;
		}
		const episode = dir === "next" ? this.nextEpisode : this.prevEpisode;
		const label = dir === "next" ? "次話" : "前話";
		// 次の話は左へ、前の話は右へめくるので、矢印もその向きに置く
		const arrow =
			dir === "next"
				? "M12 5 5 12l7 7M19 5l-7 7 7 7"
				: "M5 5l7 7-7 7M12 5l7 7-7 7";
		this.epNavEl.hidden = false;
		this.epNavEl.dataset.dir = dir;
		this.epNavEl.innerHTML =
			`<button type="button" class="nav-${dir}" aria-label="${label}: ${escapeHtml(episode.name)}">` +
			`<span class="name">${label}　${textHtml(episode.name)}</span>` +
			`<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="${arrow}" /></svg></button>`;
		this.epNavEl.querySelector("button")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.onNavigateEpisode?.(dir, episode);
		});
	}

	hideNavGuide() {
		if (!this.epNavEl) return;
		this.epNavEl.hidden = true;
		this.epNavEl.replaceChildren();
		delete this.epNavEl.dataset.dir;
	}

	// 今が最後のページなら次の話（direction が 'next'）、最初のページなら前の話（'prev'）。なければ null
	episodeBeyond(direction) {
		if (direction === "next")
			return this.page === this.pages - 1 ? this.nextEpisode : null;
		return this.page === 0 ? this.prevEpisode : null;
	}

	// サーバー上のファイルを読み直す。更新されていれば今の位置を保ったまま表示し直す
	async reload() {
		const { buffer, mtime, fromCache } = await fetchText(this.path);
		if (mtime === this.mtime) return { changed: false, fromCache };
		const before = this.hashes;
		const beforeLines = this.lines;
		this.setText(buffer, mtime);
		// 基準の指紋がまだ届いていなければ、表示していた本文と比べる
		this.baseline ??= before;
		this.baselineLines ??= beforeLines;
		this.markChanges();
		this.relayout();
		this.persist();
		return { changed: true, fromCache };
	}

	// 更新日時だけを確かめて、変わっていれば読み直す。つながらないときは何もしない
	async checkUpdate() {
		try {
			const { mtime } = await fetchStat(this.path);
			if (mtime !== this.mtime) return await this.reload();
		} catch {
			// オフライン
		}
		return { changed: false };
	}

	applyStyle(settings) {
		this.font = settings.font;
		const s = this.content.style;
		s.fontSize = `${settings.fontSize}px`;
		s.lineHeight = String(settings.lineHeight);
		const font = FONTS[settings.font] ?? FONTS.mincho;
		s.fontFamily = font.family;
		s.fontWeight = font.weight;
		// 前後の話の案内は本文の文字の大きさに合わせる
		this.el.style.setProperty("--font-size", `${settings.fontSize}px`);
		// 余白は本文の文字の大きさを単位にする。ページの要素は本文と文字の大きさが違うので、px に直して渡す
		this.el.style.setProperty(
			"--margin-block",
			`${settings.marginBlockEm * settings.fontSize}px`,
		);
		this.el.style.setProperty(
			"--margin-inline",
			`${settings.marginInlineEm * settings.fontSize}px`,
		);
	}

	applySettings(settings) {
		const fontChanged = this.font !== settings.font;
		this.applyStyle(settings);
		if (fontChanged && this.rawText) {
			this.render(this.rawText, this.mtime);
		}
		this.relayout();
		this.persist();
		this.relayoutWhenFontsLoad();
	}

	// 位置の計算でレイアウトが同期的に確定するので、フレームを待たずに組み直す。
	// 待つと、その間に来た操作が組み直し途中の状態から位置を取ってしまう
	relayout(pos = this.anchor ?? this.capture()) {
		this.anchor = pos;
		const w = Math.floor(this.pageEl.clientWidth);
		const h = Math.floor(this.pageEl.clientHeight);
		this.stride = h + GAP;
		const s = this.content.style;
		s.width = `${w}px`;
		s.height = `${h}px`;
		s.columnWidth = `${h}px`;
		s.columnGap = `${GAP}px`;
		s.setProperty("--pw", `${w}px`);
		s.setProperty("--ph", `${h}px`);
		this.pages = this.countPages();
		this.go(pos ? this.pageOf(pos) : 0, { save: false });
		// 組み直すと言葉の位置が変わるので、印を描き直す
		this.setHighlight(this.highlightRange);
		this.markNotes();
		// 複製は重いので、開いた直後ではなく少し後に作っておく
		this.peekDirty = true;
		clearTimeout(this.peekTimer);
		this.peekTimer = setTimeout(() => this.syncPeek(), 500);
	}

	syncPeek() {
		if (!this.peekDirty) return;
		this.peekContent.innerHTML = this.content.innerHTML;
		this.peekContent.style.cssText = this.content.style.cssText;
		this.peekNotesEl.innerHTML = this.notesEl.innerHTML;
		this.peekDirty = false;
	}

	colOf(y) {
		return Math.floor(
			(y - this.content.getBoundingClientRect().top) / this.stride,
		);
	}

	// 要素内の最後の非空白文字が表示されている段（ページ番号）を返す
	lastCharCol(el) {
		const { nodes } = visibleText(el);
		for (const { node } of [...nodes].reverse()) {
			for (let j = node.data.length - 1; j >= 0; j--) {
				if (/\s/.test(node.data[j])) continue;
				const range = document.createRange();
				range.setStart(node, j);
				range.setEnd(node, j + 1);
				const rect = range.getBoundingClientRect();
				if (rect.height > 0 || rect.width > 0)
					return this.colOf(rect.top + rect.height / 2);
			}
		}
		return null;
	}

	// 表示するもの（本文の文字、挿絵）がある最後の段（ページ番号）を返す
	lastContentCol() {
		for (let i = this.content.children.length - 1; i >= 0; i--) {
			const el = this.content.children[i];
			if (el.matches("img.fig")) {
				return this.colOf(el.getBoundingClientRect().bottom - 1);
			}
			if (el.matches("p")) {
				if (!el.textContent.trim()) continue;
				const col = this.lastCharCol(el);
				if (col !== null) return col;
				return this.colOf(el.getBoundingClientRect().bottom - 1);
			}
		}
		return 0;
	}

	countPages() {
		return Math.max(1, this.lastContentCol() + 1);
	}

	go(page, { save = true } = {}) {
		this.page = Math.min(Math.max(page, 0), this.pages - 1);
		this.content.style.transform = `translate3d(0, ${-this.page * this.stride}px, 0)`;
		this.marksEl.style.transform = this.content.style.transform;
		this.notesEl.style.transform = this.content.style.transform;
		this.statusEl.textContent = `${this.page + 1} / ${this.pages}`;
		this.decodeNearbyImages();
		this.updateNavGuide();
		if (save) this.saveLater();
		this.onChange?.(this.page, this.pages);
	}

	// 画像は画面に入ってから展開されるので、めくった瞬間に白く見えないよう、近くのページの挿絵を先に展開しておく
	decodeNearbyImages() {
		const peekImages = this.peekDirty
			? []
			: this.peekContent.querySelectorAll("img.fig");
		this.content.querySelectorAll("img.fig").forEach((img, i) => {
			const col = this.colOf(img.getBoundingClientRect().top);
			if (col < this.page - 1 || col > this.page + 2) return;
			img.decode().catch(() => {});
			peekImages[i]?.decode().catch(() => {});
		});
	}

	// 行番号 line の要素。その行が注記だけで要素がなければ、後ろの最初の要素。
	// 続けて何度も探すときは、els に querySelectorAll('[data-l]') の結果を渡して使い回す
	elementAt(line, els = this.content.querySelectorAll("[data-l]")) {
		let lo = 0;
		let hi = els.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (Number(els[mid].dataset.l) >= line) hi = mid;
			else lo = mid + 1;
		}
		return els[lo] ?? null;
	}

	// 基準の指紋と比べて、変わった段落に印を付ける。印は本文を描き直したときに消えている
	markChanges() {
		this.changeLines = [];
		this.changeIndex = -1;
		const before = this.baseline;
		if (
			before &&
			(before.length !== this.hashes.length ||
				before.some((h, i) => h !== this.hashes[i]))
		) {
			const { changed, hunks } = changedLines(Array.from(before), this.hashes);
			const els = this.content.querySelectorAll("[data-l]");
			for (const line of changed)
				this.elementAt(line, els)?.classList.add("changed");
			this.changeLines = hunks;
			this.peekDirty = true;
		}
		this.updateChanges();
	}

	// 本文中の段落に付箋の印を付ける
	markNotes() {
		this.content
			.querySelectorAll(".has-note")
			.forEach((el) => el.classList.remove("has-note"));
		this.notesEl.replaceChildren();
		if (!this.path) return;
		const notes = getNotesForPath(this.path);
		if (!notes.length) return;
		const origin = this.content.getBoundingClientRect();
		for (const note of notes) {
			const target = this.locate(notePosition(note));
			if (!target) continue;
			target.el.classList.add("has-note");
			const nodes = textNodes(target.el);
			const rect =
				(nodes.length ? this.charRect(nodes, target.off) : null) ??
				target.el.getBoundingClientRect();
			if (!rect.width && !rect.height) continue;
			// 印は付箋を付けた文字の行の上で、その文字のあるページの上端に置く
			const col = this.colOf(rect.top + Math.min(rect.height, this.stride) / 2);
			const left = rect.right - Math.min(rect.width, 40) / 2 - origin.left;
			this.notesEl.append(this.noteMark(note, left, col * this.stride));
		}
		this.peekDirty = true;
	}

	noteMark(note, left, top) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "note-mark";
		btn.dataset.noteId = note.id;
		if (note.text) btn.classList.add("with-text");
		btn.title = note.text ? `付箋: ${note.text}` : "付箋";
		btn.setAttribute(
			"aria-label",
			note.text ? `付箋: ${note.text}` : "付箋を開く",
		);
		btn.style.left = `${left}px`;
		btn.style.top = `${top}px`;
		btn.innerHTML =
			'<span class="note-mark-tab">' +
			'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4.2L6 21z"/></svg>' +
			"</span>";
		btn.addEventListener("mousedown", (e) => e.preventDefault());
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			// 長押しで付箋を付け外しした直後の click では開かない
			if (Date.now() < this.suppressNoteClickUntil) return;
			this.onNoteOpen?.(note.line, note.id);
		});
		return btn;
	}

	// 今のページの付箋をつけ外しする
	// noteId を渡したときはその付箋を外す
	togglePageNote(noteId = null) {
		if (!this.path) return;
		if (noteId) {
			deleteNote(noteId);
		} else {
			const notesOnPage = getNotesForPath(this.path).filter(
				(n) => this.pageOf(notePosition(n)) === this.page,
			);
			if (notesOnPage.length) for (const n of notesOnPage) deleteNote(n.id);
			else saveNote({ path: this.path, ...this.currentLineInfo(), text: "" });
		}
		this.markNotes();
	}

	// 現在表示されているページの先頭行番号・文字位置・スニペット
	currentLineInfo() {
		const pos = this.capture();
		return pos
			? { line: pos.line, off: pos.off ?? 0, snippet: pos.snippet }
			: { line: 0, off: 0, snippet: "" };
	}

	jumpToNote(note) {
		if (!note) return;
		this.go(this.pageOf(notePosition(note)));
	}

	updateChanges() {
		const count = this.changeLines.length;
		this.changesEl.hidden = count === 0;
		this.changesEl.querySelector(".next-change").textContent =
			this.changeIndex < 0
				? `変更 ${count}か所 ›`
				: `変更 ${this.changeIndex + 1}/${count} ›`;
	}

	// 変更箇所へ移る。最初に押したときは一番目の変更点に飛び、以降は今のページより後ろの次の変更箇所へ移る（最後まで行ったら最初に戻る）
	nextChange() {
		if (this.changeLines.length === 0) return;
		const els = this.content.querySelectorAll("[data-l]");
		const pages = this.changeLines.map((line) => {
			const el = this.elementAt(line, els);
			return el ? this.colOf(el.getBoundingClientRect().top) : 0;
		});
		let i =
			this.changeIndex < 0
				? 0
				: pages.findIndex(
						(p, j) =>
							p > this.page || (p === this.page && j > this.changeIndex),
					);
		if (i < 0) i = 0;
		this.changeIndex = i;
		this.updateChanges();
		this.go(pages[i]);
	}

	// 印の × で、今の本文を新しい基準にする
	clearChanges() {
		this.content
			.querySelectorAll(".changed")
			.forEach((el) => el.classList.remove("changed"));
		this.changeLines = [];
		this.changeIndex = -1;
		this.peekDirty = true;
		this.updateChanges();
		this.baseline = this.hashes;
		setBaseline(this.path, this.hashes);
		this.baselineLines = this.lines;
		setBaselineText(this.path, this.rawText);
	}

	// 変更箇所の詳細（ビフォー・アフター）を表示する
	async showCurrentDiffDetail(targetLine = null) {
		if (!this.lines || !this.changeLines.length) return;
		if (!this.baselineLines) {
			const text = await getBaselineText(this.path);
			if (text && this.path) this.baselineLines = sourceLines(text);
		}
		let hunks = this.baselineLines
			? detailedDiff(this.baselineLines, this.lines)
			: [];
		// 変更前の本文がサーバーにないときは、変わった行だけを見せる
		if (!hunks.length) {
			hunks = this.changeLines.map((line) => ({
				line,
				deleted: [BASELINE_MISSING],
				added: [this.lines[line] ?? ""],
			}));
		}
		const index = this.hunkIndexFor(hunks, targetLine);
		this.onDiffDetail?.(hunks[index], hunks, index);
	}

	// targetLine（タップした行）を含む変更のまとまり。なければその後ろの最初のまとまり。
	// targetLine がなければ、変更箇所の移動で今いるまとまり
	hunkIndexFor(hunks, targetLine) {
		if (targetLine !== null) {
			const containing = hunks.findIndex(
				(h) =>
					targetLine >= h.line &&
					targetLine <= h.line + Math.max(h.added.length, 1),
			);
			if (containing >= 0) return containing;
			const after = hunks.findIndex((h) => h.line >= targetLine);
			return after >= 0 ? after : hunks.length - 1;
		}
		const line = this.changeLines[this.changeIndex];
		if (line === undefined) return 0;
		return Math.max(
			0,
			hunks.findIndex((h) => h.line >= line),
		);
	}

	// 本文から query を探す。大文字と小文字は区別しない
	search(query) {
		const rawQ = query.trim();
		if (!rawQ) return [];
		const q = (
			this.font === "rinmincho" ? composeKanaDakuten(rawQ) : rawQ
		).toLowerCase();
		const results = [];
		for (const el of this.content.querySelectorAll("[data-l]")) {
			const { text, nodes } = visibleText(el);
			const lower = text.toLowerCase();
			for (
				let i = lower.indexOf(q);
				i >= 0 && results.length < SEARCH_LIMIT;
				i = lower.indexOf(q, i + q.length)
			) {
				const from = Math.max(0, i - 15);
				results.push({
					...this.matchAt(nodes, i, q.length),
					snippet: text.slice(from, i + q.length + 25),
					at: i - from,
					length: q.length,
				});
			}
		}
		return results;
	}

	// テキストノードの並び nodes の、at から length 文字の範囲と、それがあるページ
	matchAt(nodes, at, length) {
		const range = rangeIn(nodes, at, at + length);
		const rect = range.getBoundingClientRect();
		return { range, page: this.colOf(rect.top + rect.height / 2) };
	}

	setHighlight(range) {
		this.highlightRange = range;
		this.marksEl.replaceChildren();
		if (!range) return;
		const origin = this.content.getBoundingClientRect();
		for (const r of range.getClientRects()) {
			const mark = document.createElement("div");
			mark.className = "search-mark";
			Object.assign(mark.style, {
				left: `${r.left - origin.left}px`,
				top: `${r.top - origin.top}px`,
				width: `${r.width}px`,
				height: `${r.height}px`,
			});
			this.marksEl.append(mark);
		}
	}

	showMatch(match) {
		this.setHighlight(match.range);
		this.go(match.page);
	}

	// 横断検索の結果から開いたとき、その行（と見つかった言葉）のページへ移る
	jumpTo(line, query) {
		const el = this.elementAt(line);
		if (!el) return;
		if (query) {
			const { text, nodes } = visibleText(el);
			const q = query.trim();
			const i = text.toLowerCase().indexOf(q.toLowerCase());
			if (i >= 0) {
				this.showMatch(this.matchAt(nodes, i, q.length));
				return;
			}
		}
		this.go(this.colOf(el.getBoundingClientRect().top));
	}

	// スワイプ中。dx > 0（右へ）なら次のページを左から、dx < 0 なら前のページを右から並べる
	dragTo(dx) {
		const target = dx > 0 ? this.page + 1 : this.page - 1;
		const exists = dx !== 0 && target >= 0 && target < this.pages;
		const canAdvance =
			dx !== 0 && Boolean(this.episodeBeyond(dx > 0 ? "next" : "prev"));
		// 最初と最後のページでは、次話/前話へ進める場合でも少し抵抗をつけて端であることを伝える
		const x = exists ? dx : canAdvance ? dx * 0.5 : dx * 0.3;
		this.pageEl.style.transform = `translate3d(${x}px, 0, 0)`;
		this.peekEl.hidden = !exists;
		if (exists) {
			const transform = `translate3d(0, ${-target * this.stride}px, 0)`;
			this.peekContent.style.transform = transform;
			this.peekNotesEl.style.transform = transform;
			this.peekEl.style.transform = `translate3d(${x - Math.sign(dx) * window.innerWidth}px, 0, 0)`;
		}
		return exists ? target : null;
	}

	// 指を離したら、めくるか元に戻すかを決めて滑らせる
	endDrag(dx, velocity) {
		const width = window.innerWidth;
		const target = this.dragTo(dx);
		const forward = velocity * Math.sign(dx);
		const commit =
			forward > -FLICK_VELOCITY &&
			(Math.abs(dx) > width * COMMIT_RATIO || forward > FLICK_VELOCITY);

		// 最後のページから右へ、最初のページから左へ払ったら、ページを画面の外へ送ってから次の話・前の話へ移る
		const direction = dx > 0 ? "next" : "prev";
		const episode = this.episodeBeyond(direction);
		if (target === null && commit && dx !== 0 && episode) {
			this.sliding = true;
			this.pageEl.style.transition = `transform ${SLIDE_MS}ms ease-out`;
			this.pageEl.style.transform = `translate3d(${Math.sign(dx) * width}px, 0, 0)`;
			setTimeout(() => {
				this.pageEl.style.transition = "";
				this.pageEl.style.transform = "";
				this.peekEl.hidden = true;
				this.sliding = false;
				this.onNavigateEpisode?.(direction, episode);
			}, SLIDE_MS);
			return;
		}

		const x = commit && target !== null ? Math.sign(dx) * width : 0;
		this.sliding = true;
		for (const el of [this.pageEl, this.peekEl])
			el.style.transition = `transform ${SLIDE_MS}ms ease-out`;
		this.pageEl.style.transform = `translate3d(${x}px, 0, 0)`;
		this.peekEl.style.transform = `translate3d(${x - Math.sign(dx) * width}px, 0, 0)`;
		setTimeout(() => {
			for (const el of [this.pageEl, this.peekEl]) el.style.transition = "";
			this.pageEl.style.transform = "";
			this.peekEl.hidden = true;
			if (commit && target !== null) this.go(target);
			this.sliding = false;
		}, SLIDE_MS);
	}

	next({ allowEpisode = true } = {}) {
		if (this.page < this.pages - 1) {
			this.go(this.page + 1);
			return "page";
		}
		if (this.nextEpisode && allowEpisode) {
			this.onNavigateEpisode?.("next", this.nextEpisode);
			return "episode";
		}
		return false;
	}

	prev({ allowEpisode = true } = {}) {
		if (this.page > 0) {
			this.go(this.page - 1);
			return "page";
		}
		if (this.prevEpisode && allowEpisode) {
			this.onNavigateEpisode?.("prev", this.prevEpisode);
			return "episode";
		}
		return false;
	}

	// ページをめくっている最中は重い位置計算を遅延させ、めくりが止まってから保存する
	saveLater() {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.save();
		}, 400);
	}

	// めくったあとの保存待ちがあるときだけ保存する。
	// 何もしていないのに保存すると、他の端末で進んだ位置を古い位置で上書きしてしまう
	flushSave() {
		if (this.saveTimer && this.path) this.save();
	}

	// 今のページの先頭を新しい基準位置にして保存する
	save() {
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
		this.anchor = this.capture();
		this.persist();
	}

	persist() {
		if (!this.anchor) return;
		this.savedAt = setPosition(this.path, {
			...this.anchor,
			page: this.page,
			pages: this.pages,
			mtime: this.mtime,
		}).updatedAt;
	}

	// 他の端末で、今のページより先まで読み進められているときの、その位置。なければ null
	remoteAhead() {
		if (!this.path || this.saveTimer) return null;
		const pos = getPosition(this.path);
		if (!pos || (pos.updatedAt ?? 0) <= this.savedAt) return null;
		return this.pageOf(pos) > this.page ? pos : null;
	}

	// 保存されている位置のページへ移る
	goToPosition(pos) {
		this.go(this.pageOf(pos), { save: false });
		this.save();
	}

	charRect(nodes, off) {
		const i = nodes.findLastIndex((n) => n.start <= off);
		if (i < 0) return null;
		const { node, start } = nodes[i];
		const pos = Math.min(off - start, Math.max(0, node.length - 1));
		const range = document.createRange();
		range.setStart(node, pos);
		range.setEnd(node, Math.min(pos + 1, node.length));
		const rect = range.getBoundingClientRect();
		return rect.height || rect.width ? rect : null;
	}

	charCol(nodes, off) {
		const rect = this.charRect(nodes, off);
		if (!rect || !rect.height) return null;
		return this.colOf(rect.top + rect.height / 2);
	}

	// 今のページの先頭が、どの行の何文字目かを返す
	capture() {
		const els = this.content.children;
		if (!els.length || !this.path) return null;
		let lo = 0;
		let hi = els.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.colOf(els[mid].getBoundingClientRect().bottom - 1) >= this.page)
				hi = mid;
			else lo = mid + 1;
		}
		let el = els[lo];
		while (el && el.dataset.l === undefined) el = el.nextElementSibling;
		if (!el) {
			// 本文の後ろ（次の話へのリンクだけのページ）なら、本文の末尾を位置にする
			const last = [...els].findLast((e) => e.dataset.l !== undefined);
			if (!last) return null;
			return {
				line: Number(last.dataset.l),
				off: last.textContent.length,
				snippet: "",
			};
		}

		let off = 0;
		if (this.colOf(el.getBoundingClientRect().top) < this.page) {
			// 前のページから続いている段落なので、このページに入る最初の文字を二分探索する
			const nodes = textNodes(el);
			let a = 0;
			let b = el.textContent.length;
			while (a < b) {
				const mid = (a + b) >> 1;
				const col = this.charCol(nodes, mid);
				if (col !== null && col >= this.page) b = mid;
				else a = mid + 1;
			}
			off = a;
		}
		return {
			line: Number(el.dataset.l),
			off,
			snippet: el.textContent.slice(off, off + SNIPPET_LENGTH),
		};
	}

	// 保存した位置の要素を探す。原稿の書き換えで行がずれていたら、保存しておいた文字列で探し直す
	locate(pos) {
		const el = this.content.querySelector(`[data-l="${pos.line}"]`);
		if (el && (!pos.snippet || el.textContent.startsWith(pos.snippet, pos.off)))
			return { el, off: pos.off };
		const lines = [...this.content.querySelectorAll("[data-l]")];
		if (pos.snippet) {
			let best = null;
			for (const e of lines) {
				const i = e.textContent.indexOf(pos.snippet);
				if (i < 0) continue;
				const d = Math.abs(Number(e.dataset.l) - pos.line);
				if (!best || d < best.d) best = { el: e, off: i, d };
			}
			if (best) return best;
		}
		if (el) return { el, off: Math.min(pos.off, el.textContent.length) };
		const before = lines.findLast((e) => Number(e.dataset.l) <= pos.line);
		return before ? { el: before, off: 0 } : null;
	}

	pageOf(pos) {
		const target = this.locate(pos);
		if (!target) return 0;
		const rect = target.el.getBoundingClientRect();
		if (target.off > 0 && target.off >= target.el.textContent.length) {
			return this.colOf(target.el.getBoundingClientRect().bottom - 1);
		}
		if (target.off > 0) {
			const col = this.charCol(textNodes(target.el), target.off);
			if (col !== null) return col;
		}
		return this.colOf(rect.top);
	}

	bindGestures() {
		let start = null;
		// スワイプで指に追従させているときの { lastX, lastT, velocity }
		let drag = null;
		// 挿絵の 1 回目のタップ。ダブルタップでなければ、待ってから普通のタップとして扱う
		let pendingTap = null;
		// ページ上端（付箋エリア）の長押しタイマー
		let longPressTimer = null;
		const cancelLongPress = () => {
			if (longPressTimer) {
				clearTimeout(longPressTimer);
				longPressTimer = null;
			}
		};
		this.el.addEventListener("pointerdown", (e) => {
			// マウスの右クリックなどではめくらない
			if (this.sliding || e.button !== 0) return;
			cancelLongPress();
			// マウスでは引っぱるとめくる代わりに文字を選ぶ。選んでいるときのクリックは選択を解くだけにする
			const mouse = e.pointerType === "mouse";
			start = {
				x: e.clientX,
				y: e.clientY,
				mouse,
				selected: mouse && !document.getSelection().isCollapsed,
			};
			drag = null;
			const noteBtn = e.target.closest(".note-mark");
			const inNoteArea =
				noteBtn ||
				e.clientY <= this.pageEl.getBoundingClientRect().top + NOTE_AREA_HEIGHT;
			if (
				inNoteArea &&
				!e.target.closest("a, .changes, .ep-nav") &&
				this.canDrag?.()
			) {
				const targetNoteId = noteBtn?.dataset.noteId ?? null;
				longPressTimer = setTimeout(() => {
					longPressTimer = null;
					start = null;
					this.suppressNoteClickUntil = Date.now() + 800;
					vibrate();
					this.togglePageNote(targetNoteId);
				}, LONG_PRESS_MS);
			}
		});
		this.el.addEventListener("pointermove", (e) => {
			if (!start) return;
			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			if (longPressTimer && Math.hypot(dx, dy) > 10) cancelLongPress();
			if (start.mouse) return;
			if (!drag) {
				if (
					Math.abs(dx) < 10 ||
					Math.abs(dx) < Math.abs(dy) ||
					!this.canDrag?.()
				)
					return;
				cancelLongPress();
				this.syncPeek();
				this.el.setPointerCapture(e.pointerId);
				drag = { lastX: e.clientX, lastT: e.timeStamp, velocity: 0 };
			}
			const dt = e.timeStamp - drag.lastT;
			if (dt > 0) drag.velocity = (e.clientX - drag.lastX) / dt;
			drag.lastX = e.clientX;
			drag.lastT = e.timeStamp;
			this.dragTo(dx);
		});
		this.el.addEventListener("pointercancel", () => {
			cancelLongPress();
			if (drag) this.endDrag(0, 0);
			start = null;
			drag = null;
		});
		this.el.addEventListener("pointerup", (e) => {
			cancelLongPress();
			if (!start) return;
			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			const { mouse, selected } = start;
			start = null;
			if (mouse && selected) {
				// 余白など選べないところをクリックしても、ブラウザは選択を解かない
				if (Math.abs(dx) <= 10 && Math.abs(dy) <= 10)
					document.getSelection().removeAllRanges();
				return;
			}
			if (mouse && !document.getSelection().isCollapsed) return;
			if (drag) {
				// 指を止めてから離したときは勢いなしとみなす
				const velocity = e.timeStamp - drag.lastT > 100 ? 0 : drag.velocity;
				drag = null;
				this.endDrag(dx, velocity);
				return;
			}
			// リンク（次の話）やボタン（変更箇所へ）はページ送りにしない
			if (e.target.closest("a, button")) return;
			if (!mouse && Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy)) {
				// 縦書きなので、右へ払うと次のページ
				this.onTap(dx > 0 ? "next" : "prev");
				return;
			}
			if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
			const pointEl = document.elementFromPoint(e.clientX, e.clientY);
			const changedEl =
				e.target.closest(".changed") || pointEl?.closest(".changed");
			if (changedEl && this.changeLines.length > 0) {
				const line = Number(changedEl.dataset.l);
				void this.showCurrentDiffDetail(line);
				return;
			}
			const ratio = e.clientX / window.innerWidth;
			const zone = ratio < 0.35 ? "next" : ratio > 0.65 ? "prev" : "menu";
			const img = e.target.closest("img.fig");
			if (pendingTap) {
				clearTimeout(pendingTap.timer);
				const isDouble =
					img &&
					pendingTap.img === img &&
					e.timeStamp - pendingTap.time < DOUBLE_TAP_MS;
				const first = pendingTap;
				pendingTap = null;
				if (isDouble) {
					this.onImageOpen?.(img.currentSrc || img.src);
					return;
				}
				this.onTap(first.zone);
			}
			if (img) {
				pendingTap = {
					img,
					zone,
					time: e.timeStamp,
					timer: setTimeout(() => {
						pendingTap = null;
						this.onTap(zone);
					}, DOUBLE_TAP_MS),
				};
				return;
			}
			this.onTap(zone);
		});
		// マウスで挿絵やリンクを引っぱると、めくる代わりにブラウザのドラッグが始まってしまう
		this.el.addEventListener("dragstart", (e) => e.preventDefault());
		// マウスのホイールやトラックパッドでめくる。下へ回す・右へ払うと次のページ。
		// 回し続ければ次々とめくるが、トラックパッドの細かい入力で飛びすぎないよう間隔を空ける
		let lastWheel = -Infinity;
		this.el.addEventListener(
			"wheel",
			(e) => {
				// ピンチでの拡大はブラウザに任せる
				if (e.ctrlKey) return;
				e.preventDefault();
				if (
					e.timeStamp - lastWheel < WHEEL_INTERVAL_MS ||
					this.sliding ||
					!this.canDrag?.()
				)
					return;
				const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
				const delta =
					(Math.abs(e.deltaX) > Math.abs(e.deltaY) ? -e.deltaX : e.deltaY) *
					unit;
				if (Math.abs(delta) < WHEEL_THRESHOLD) return;
				lastWheel = e.timeStamp;
				if (delta > 0) this.next();
				else this.prev();
			},
			{ passive: false },
		);
	}
}
