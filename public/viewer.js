// 挿絵を全画面で表示し、ピンチで拡大縮小・1 本指で移動・ダブルタップで拡大の切り替えをする

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;

const viewerEl = document.querySelector("#viewer");
const img = viewerEl.querySelector("img");

// 画面に収めたときの画像の位置と大きさ（base）と、そこからの拡大率・移動量
let base = { x: 0, y: 0, w: 0, h: 0 };
let scale = 1;
let tx = 0;
let ty = 0;

const pointers = new Map();
let gesture = null;
let lastTap = null;

function apply(animate = false) {
	img.style.transition = animate ? "transform 200ms ease-out" : "";
	img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
}

function fit() {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const ratio = Math.min(vw / img.naturalWidth, vh / img.naturalHeight);
	const w = img.naturalWidth * ratio;
	const h = img.naturalHeight * ratio;
	base = { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
	Object.assign(img.style, {
		left: `${base.x}px`,
		top: `${base.y}px`,
		width: `${w}px`,
		height: `${h}px`,
	});
}

// 画像が画面より小さい向きは中央に、大きい向きは端が画面の内側に入らないようにする
function clamp() {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const axis = (t, size, origin, view) => {
		const scaled = size * scale;
		if (scaled <= view) return (view - scaled) / 2 - origin;
		return Math.min(-origin, Math.max(view - origin - scaled, t));
	};
	tx = axis(tx, base.w, base.x, vw);
	ty = axis(ty, base.h, base.y, vh);
}

// 画面上の点 (px, py) にある画像の位置を保ったまま、拡大率を newScale にする
function zoomAt(px, py, newScale) {
	const qx = (px - base.x - tx) / scale;
	const qy = (py - base.y - ty) / scale;
	scale = newScale;
	tx = px - base.x - qx * scale;
	ty = py - base.y - qy * scale;
}

function reset() {
	scale = 1;
	tx = 0;
	ty = 0;
}

// まずページに表示していた画像（src）を出し、拡大用の大きい画像（largeSrc）が届いたら差し替える。
// 縦横比は同じなので、表示中の位置や拡大率はそのまま保てる
let loadingLarge = null;

export function openViewer(src, largeSrc) {
	reset();
	img.style.transform = "";
	img.src = src;
	viewerEl.hidden = false;
	const show = () => {
		fit();
		apply();
	};
	if (img.complete && img.naturalWidth) show();
	else img.addEventListener("load", show, { once: true });

	if (!largeSrc || largeSrc === src) return;
	const large = new Image();
	loadingLarge = large;
	large.onload = () => {
		if (loadingLarge !== large || viewerEl.hidden) return;
		loadingLarge = null;
		img.src = largeSrc;
	};
	large.src = largeSrc;
}

export function closeViewer() {
	viewerEl.hidden = true;
	loadingLarge = null;
	img.removeAttribute("src");
}

export function isViewerOpen() {
	return !viewerEl.hidden;
}

function startGesture() {
	const pts = [...pointers.values()];
	if (pts.length >= 2) {
		const [a, b] = pts;
		gesture = {
			type: "pinch",
			dist: Math.hypot(a.x - b.x, a.y - b.y),
			scale,
			// ピンチを始めた点にある画像の位置
			qx: ((a.x + b.x) / 2 - base.x - tx) / scale,
			qy: ((a.y + b.y) / 2 - base.y - ty) / scale,
		};
	} else if (pts.length === 1) {
		gesture = { type: "pan", x: pts[0].x, y: pts[0].y, tx, ty, moved: false };
	} else {
		gesture = null;
	}
}

viewerEl.addEventListener("pointerdown", (e) => {
	if (e.target.closest("button")) return;
	try {
		viewerEl.setPointerCapture(e.pointerId);
	} catch {
		// 捕捉できなくても、ビューは画面全体を覆っているので操作は続けられる
	}
	pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
	startGesture();
});

viewerEl.addEventListener("pointermove", (e) => {
	if (!pointers.has(e.pointerId) || !gesture) return;
	pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
	const pts = [...pointers.values()];
	if (gesture.type === "pinch" && pts.length >= 2) {
		const [a, b] = pts;
		const dist = Math.hypot(a.x - b.x, a.y - b.y);
		// 縮小しすぎたときは少しだけ縮んで、離すと元に戻る
		scale = Math.min(
			MAX_SCALE,
			Math.max(0.6, (gesture.scale * dist) / gesture.dist),
		);
		tx = (a.x + b.x) / 2 - base.x - gesture.qx * scale;
		ty = (a.y + b.y) / 2 - base.y - gesture.qy * scale;
		apply();
	} else if (gesture.type === "pan") {
		const dx = e.clientX - gesture.x;
		const dy = e.clientY - gesture.y;
		if (Math.abs(dx) > 5 || Math.abs(dy) > 5) gesture.moved = true;
		tx = gesture.tx + dx;
		ty = gesture.ty + dy;
		clamp();
		apply();
	}
});

function endPointer(e) {
	if (!pointers.has(e.pointerId)) return;
	const wasTap =
		gesture?.type === "pan" && !gesture.moved && pointers.size === 1;
	pointers.delete(e.pointerId);
	if (wasTap && e.type === "pointerup")
		handleTap(e.clientX, e.clientY, e.timeStamp);
	if (pointers.size === 0) {
		if (scale < 1) reset();
		clamp();
		apply(true);
	}
	startGesture();
}

function handleTap(x, y, time) {
	if (
		lastTap &&
		time - lastTap.time < DOUBLE_TAP_MS &&
		Math.hypot(x - lastTap.x, y - lastTap.y) < 30
	) {
		lastTap = null;
		if (scale > 1.01) reset();
		else zoomAt(x, y, DOUBLE_TAP_SCALE);
		clamp();
		apply(true);
		return;
	}
	lastTap = { x, y, time };
}

viewerEl.addEventListener("pointerup", endPointer);
viewerEl.addEventListener("pointercancel", endPointer);

viewerEl.querySelector(".close").addEventListener("click", closeViewer);

// マウスのホイールやトラックパッドのピンチで、指している位置を中心に拡大縮小する
viewerEl.addEventListener(
	"wheel",
	(e) => {
		e.preventDefault();
		const delta =
			e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
		// ピンチは 1 回あたりの量が小さいので、強めに効かせる
		const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002));
		zoomAt(
			e.clientX,
			e.clientY,
			Math.min(MAX_SCALE, Math.max(1, scale * factor)),
		);
		clamp();
		apply();
	},
	{ passive: false },
);

// Firefox は CSS では画像のドラッグを止められない
viewerEl.addEventListener("dragstart", (e) => e.preventDefault());

window.addEventListener("resize", () => {
	if (viewerEl.hidden || !img.naturalWidth) return;
	reset();
	fit();
	apply();
});
