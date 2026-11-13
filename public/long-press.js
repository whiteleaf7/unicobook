// 長押しで onLongPress、通常のタップで onClick（省略時はイベント伝播に任せる）を呼ぶ

const LONG_PRESS_MS = 500;
// 指がこれ以上動いたら長押しをやめる（px）
const MOVE_TOLERANCE = 10;
// 長押しのあと、指を離したときに来る click を無視する時間
const SUPPRESS_CLICK_MS = 800;

export function attachLongPress(el, onLongPress, onClick = null) {
	let timer = null;
	let startX = 0;
	let startY = 0;
	let suppressClick = false;

	const cancel = () => {
		clearTimeout(timer);
		timer = null;
	};

	el.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		cancel();
		startX = e.clientX;
		startY = e.clientY;
		timer = setTimeout(() => {
			timer = null;
			suppressClick = true;
			setTimeout(() => (suppressClick = false), SUPPRESS_CLICK_MS);
			try {
				navigator.vibrate?.(50);
			} catch {}
			onLongPress(e);
		}, LONG_PRESS_MS);
	});

	el.addEventListener("pointermove", (e) => {
		if (
			timer &&
			Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE
		)
			cancel();
	});
	el.addEventListener("pointerup", cancel);
	el.addEventListener("pointercancel", cancel);

	el.addEventListener("click", (e) => {
		if (suppressClick) {
			suppressClick = false;
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		onClick?.(e);
	});

	// 長押しで出るメニューを出さない
	el.addEventListener("contextmenu", (e) => {
		if (suppressClick) e.preventDefault();
	});
}
