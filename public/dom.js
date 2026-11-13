// 画面を組み立てるための小さな道具

export const $ = (sel, root = document) => root.querySelector(sel);

// 要素を作る。attrs の class は className に、on で始まるものはイベントに、true / false は属性の有無にする。
// children の null や undefined は飛ばし、配列は平らにする
export function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null) continue;
		if (k === "class") el.className = v;
		else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (typeof v === "boolean") {
			if (v) el.setAttribute(k, "");
			if (k in el) el[k] = v;
		} else el.setAttribute(k, v);
	}
	el.append(...children.flat().filter((c) => c != null));
	return el;
}
