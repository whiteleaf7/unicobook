// 前回読んだときの本文と比べて、変わった行や文字を見つける。
// 変わった行の印は、本文そのものではなく行ごとの指紋（32bit のハッシュ）だけで比べる

export function lineHashes(lines) {
	return lines.map((line) => {
		// FNV-1a
		let h = 0x811c9dc5;
		for (let i = 0; i < line.length; i++) {
			h ^= line.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	});
}

// これ以上変更が多いときは、細かく比べるのをあきらめる（比較の時間と記憶を抑えるため）
const MAX_EDITS = 2000;

// Myers の差分で、a を b にする最短の手順を先頭から順に返す。手順は次のどれか。
// - { type: 'equal', a: a の位置, b: b の位置 }
// - { type: 'delete', a: 消す a の位置, b: 消したあとに続く b の位置 }
// - { type: 'insert', b: 足す b の位置 }
// 変更が maxEdits を超えるときは null を返す
function shortestEdit(a, b, maxEdits = a.length + b.length) {
	const n = a.length;
	const m = b.length;
	if (n === 0 && m === 0) return [];
	const max = Math.min(n + m, maxEdits);
	const offset = max + 1;
	// v[offset + k] は、対角線 k（x - y = k）上で、今の変更回数で進める最も遠い x
	const v = new Int32Array(2 * max + 3);
	// 戻って手順を復元するため、変更回数ごとの v を残しておく
	const trace = [];
	// 対角線 k へは、上の対角線から下へ進んで来るか（true）、下の対角線から右へ進んで来るか（false）
	const goesDown = (v, d, k) =>
		k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);

	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x = goesDown(v, d, k) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) return backtrack();
		}
	}
	return null;

	function backtrack() {
		const ops = [];
		let x = n;
		let y = m;
		for (let d = trace.length - 1; d > 0; d--) {
			const k = x - y;
			const prevK = goesDown(trace[d], d, k) ? k + 1 : k - 1;
			const prevX = trace[d][offset + prevK];
			const prevY = prevX - prevK;
			// 斜めに進んだ分は同じ
			while (x > prevX && y > prevY)
				ops.push({ type: "equal", a: --x, b: --y });
			// 下へ進んだなら b の挿入、右へ進んだなら a の削除
			if (x === prevX) ops.push({ type: "insert", b: prevY });
			else ops.push({ type: "delete", a: prevX, b: prevY });
			x = prevX;
			y = prevY;
		}
		// 残りは先頭から同じ部分
		while (x > 0) ops.push({ type: "equal", a: --x, b: --y });
		return ops.reverse();
	}
}

// 新しい本文の行番号のうち、追加・書き換えられた行と、行が削除された直後の行を返す。
// hunks は連続した変更のまとまりごとの先頭の行番号
export function changedLines(before, after) {
	const changed = new Set();
	const { start, endA, endB } = commonEnds(before, after);
	const a = before.slice(start, endA);
	const b = after.slice(start, endB);
	const mark = (i) => changed.add(Math.min(start + i, after.length - 1));

	const ops = shortestEdit(a, b, MAX_EDITS);
	if (ops) {
		for (const op of ops) if (op.type !== "equal") mark(op.b);
	} else {
		// 変更が多すぎるときは、最初に違う行から後ろを全部変更とみなす
		for (let i = 0; i < Math.max(b.length, 1); i++) mark(i);
	}
	if (after.length === 0) changed.clear();
	return { changed, hunks: toHunks(changed) };
}

// 先頭と末尾の同じ部分を除いた範囲。a.slice(start, endA) と b.slice(start, endB) だけを比べればよい
function commonEnds(a, b) {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	return { start, endA, endB };
}

function toHunks(changed) {
	const sorted = [...changed].sort((p, q) => p - q);
	return sorted.filter((line, i) => i === 0 || line - sorted[i - 1] > 1);
}

// 変更前（before）と変更後（after）の行を比べて、
// 変更のまとまりごとの { line: 変更後の行番号, deleted: 消えた行, added: 足された行 } の配列を返す
export function detailedDiff(before, after) {
	const ops = shortestEdit(before, after, MAX_EDITS);
	// 変更が多すぎるときは、全体を 1 つの置き換えとする
	if (!ops) return [{ line: 0, deleted: [...before], added: [...after] }];

	const hunks = [];
	let current = null;
	for (const op of ops) {
		if (op.type === "equal") {
			if (current) hunks.push(current);
			current = null;
			continue;
		}
		current ??= { line: op.b, deleted: [], added: [] };
		if (op.type === "delete") current.deleted.push(before[op.a]);
		else current.added.push(after[op.b]);
	}
	if (current) hunks.push(current);
	return hunks;
}

// 2 つの文字列を文字単位で比べて、
// 変更前に出す並び（equal / delete）と変更後に出す並び（equal / insert）を返す。
// 並びの要素は { type, text } で、同じ種類が続くところは 1 つにまとめる
export function diffChars(beforeStr, afterStr) {
	const a = [...beforeStr];
	const b = [...afterStr];
	const before = [];
	const after = [];
	const equal = (text) => {
		appendMerged(before, "equal", text);
		appendMerged(after, "equal", text);
	};

	// 前後の同じ部分を除いた中ほどだけを比べる
	const { start, endA, endB } = commonEnds(a, b);
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	equal(a.slice(0, start).join(""));
	for (const op of shortestEdit(midA, midB)) {
		if (op.type === "equal") equal(midA[op.a]);
		else if (op.type === "delete") appendMerged(before, "delete", midA[op.a]);
		else appendMerged(after, "insert", midB[op.b]);
	}
	equal(a.slice(endA).join(""));
	return { before, after };
}

function appendMerged(parts, type, text) {
	if (!text) return;
	const last = parts[parts.length - 1];
	if (last?.type === type) last.text += text;
	else parts.push({ type, text });
}
