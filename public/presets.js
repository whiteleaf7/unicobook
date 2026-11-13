// フォルダのアイコンに選べるプリセット。色付きのタイルに白い線画か文字を描く

const SYMBOLS = [
	{
		id: "book",
		color: "#3b6ea8",
		d: "M4.5 5h5a2.5 2.5 0 0 1 2.5 2.5V19a2 2 0 0 0-2-2H4.5zM19.5 5h-5A2.5 2.5 0 0 0 12 7.5V19a2 2 0 0 1 2-2h5.5z",
	},
	{
		id: "star",
		color: "#d99a1e",
		d: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z",
	},
	{
		id: "heart",
		color: "#d9466f",
		d: "M12 19.5s-7-4.3-7-9.5A4 4 0 0 1 12 7.5a4 4 0 0 1 7 2.5c0 5.2-7 9.5-7 9.5z",
	},
	{
		id: "moon",
		color: "#4b4f8f",
		d: "M18.5 14.5A7 7 0 1 1 9.5 5.5a5.5 5.5 0 0 0 9 9z",
	},
	{
		id: "sun",
		color: "#e2742b",
		d: "M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4",
	},
	{
		id: "sword",
		color: "#5d6b78",
		d: "M19.5 4.5 9.5 14.5M15 4.5h4.5V9M6.5 12.5l5 5M8 16l-3.5 3.5",
	},
	{
		id: "flower",
		color: "#c55aa0",
		d: "M12 9.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM12 9.8a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6zM14.2 12a2.8 2.8 0 1 1 5.6 0 2.8 2.8 0 0 1-5.6 0zM12 14.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zM9.8 12a2.8 2.8 0 1 1-5.6 0 2.8 2.8 0 0 1 5.6 0z",
	},
	{
		id: "cat",
		color: "#8a6a4f",
		d: "M5.5 19.5v-8L4.5 5l4 3h7l4-3-1 6.5v8zM9.5 13v.5M14.5 13v.5M11 16h2",
	},
	{
		id: "music",
		color: "#7a4fc0",
		d: "M9 17.5V6l10-2v11.5M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
	},
	{
		id: "flame",
		color: "#d6452f",
		d: "M12 20.5c-3.4 0-5.7-2.4-5.7-5.5 0-3.3 2.8-4.8 3.3-8.8 1.9 1.2 2.9 2.9 2.9 4.6.9-.8 1.5-1.9 1.6-3.1 2.2 1.8 3.6 4.4 3.6 7.3 0 3.1-2.3 5.5-5.7 5.5z",
	},
	{
		id: "leaf",
		color: "#3f9a52",
		d: "M5 19c0-7.5 4.8-13.5 14-13.5 0 8.5-5.8 13.5-14 13.5zM5 19l7.5-7.5",
	},
	{
		id: "gem",
		color: "#2d9bb0",
		d: "M7 4.5h10l3.5 4.5L12 19.5 3.5 9zM3.5 9h17M9.5 4.5 12 19.5l2.5-15",
	},
	{
		id: "rocket",
		color: "#4a5fc1",
		d: "M12 3.5c2.8 1.9 4.2 5.2 3.7 9.5l-1.7 2.5h-4L8.3 13c-.5-4.3.9-7.6 3.7-9.5zM12 8.5v.5M10 15.5l-2 4 4-1.5 4 1.5-2-4",
	},
	{
		id: "coffee",
		color: "#7b5236",
		d: "M5 9.5h10.5v4a5 5 0 0 1-5 5h-.5a5 5 0 0 1-5-5zM15.5 10.5h1.5a2.5 2.5 0 0 1 0 5h-1.5M8 4v2.5M10.5 4v2.5M13 4v2.5",
	},
	{
		id: "crown",
		color: "#c9a227",
		d: "M4.5 17.5h15l1-9.5-5 4-3.5-6-3.5 6-5-4zM4.5 20h15",
	},
	{ id: "bolt", color: "#e0b21b", d: "M13 3 5.5 13.5h6L10.5 21 18 10.5h-6z" },
	{
		id: "school",
		color: "#2f7f73",
		d: "M3.5 10 12 5l8.5 5M5.5 10v9.5h13V10M10 19.5V15h4v4.5",
	},
	{
		id: "ghost",
		color: "#6d7a8a",
		d: "M6 20V11a6 6 0 0 1 12 0v9l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5zM10 11v.5M14 11v.5",
	},
	{
		id: "pen",
		color: "#3d5a80",
		d: "M15.5 4.5l4 4L9 19l-5 1 1-5zM13.5 6.5l4 4",
	},
	{
		id: "wand",
		color: "#8e44ad",
		d: "M4 20 14.5 9.5M14.5 9.5l2-2M18 3.5l.7 1.8 1.8.7-1.8.7L18 8.5l-.7-1.8-1.8-.7 1.8-.7z",
	},
	{
		id: "shield",
		color: "#34618f",
		d: "M12 3.5 19 6v5.5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
	},
	{
		id: "castle",
		color: "#7a6a8f",
		d: "M4 20V9h3v2h2V9h2v2h2V9h2v2h2V9h3v11zM10 20v-4h4v4",
	},
	{
		id: "tree",
		color: "#2e7d4f",
		d: "M12 3.5 6 12h3l-4 5.5h14L15 12h3zM12 17.5V21",
	},
	{ id: "mountain", color: "#5b7a8c", d: "M2.5 19.5 9 8l4 7 2.5-4 6 8.5z" },
	{
		id: "wave",
		color: "#2b7bb9",
		d: "M3 9c2.5-2 4.5-2 7 0s4.5 2 7 0c1.3-1 2.5-1.5 4-1.5M3 15c2.5-2 4.5-2 7 0s4.5 2 7 0c1.3-1 2.5-1.5 4-1.5",
	},
	{
		id: "cloud",
		color: "#6c8fb3",
		d: "M7 18.5a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6-1.2 4.2 4.2 0 0 1 .4 9.2z",
	},
	{
		id: "snow",
		color: "#4a9fc8",
		d: "M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6l2.5-1.5M9.5 19.5 12 18l2.5 1.5",
	},
	{
		id: "umbrella",
		color: "#c0504d",
		d: "M3.5 12a8.5 8.5 0 0 1 17 0zM12 12v6.5a2 2 0 0 1-4 0M12 3.5V5",
	},
	{
		id: "key",
		color: "#b8860b",
		d: "M8.5 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM11.5 12.5 20 21M16.5 17.5l2-2M14.5 15.5l1.5-1.5",
	},
	{
		id: "camera",
		color: "#555f6e",
		d: "M4 8h3.5L9 5.5h6L16.5 8H20v11H4zM12 10.5a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z",
	},
	{
		id: "glasses",
		color: "#46506a",
		d: "M3 13a3.5 3.5 0 1 0 7 0 3.5 3.5 0 0 0-7 0zM14 13a3.5 3.5 0 1 0 7 0 3.5 3.5 0 0 0-7 0zM10 13c1.3-1 2.7-1 4 0M3 13l1.5-4.5M21 13l-1.5-4.5",
	},
	{
		id: "paw",
		color: "#a0674b",
		d: "M12 13c3 0 5 2.5 5 4.5S15 20 12 20s-5-.5-5-2.5S9 13 12 13zM6.5 9.5v2.5M9.5 6v2.5M14.5 6v2.5M17.5 9.5v2.5",
	},
	{
		id: "anchor",
		color: "#1f5f8b",
		d: "M12 7.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4zM12 7.5V20M8 11h8M4.5 13.5c0 4 3.5 6.5 7.5 6.5s7.5-2.5 7.5-6.5",
	},
	{
		id: "hourglass",
		color: "#9c7a3c",
		d: "M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 5 9 6 9 8.5s-9 3.5-9 8.5M16.5 3.5c0 5-9 6-9 8.5s9 3.5 9 8.5",
	},
	{ id: "flag", color: "#d0453a", d: "M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11" },
	{
		id: "cherry",
		color: "#c2185b",
		d: "M8 20a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM16.5 18a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM8 14c1-5 3.5-8.5 8-10.5M16.5 12c-.5-3.5-.5-6-.5-8.5",
	},
	{
		id: "gift",
		color: "#d35d6e",
		d: "M4.5 10h15v10.5h-15zM3.5 7h17v3h-17zM12 7v13.5M12 7c-1.5-3.5-6-3.5-5 0M12 7c1.5-3.5 6-3.5 5 0",
	},
	{
		id: "compass",
		color: "#3f7f6a",
		d: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM15.5 8.5l-2 5-5 2 2-5z",
	},
];

// 文字のタイルは、この色を順に使う
const TEXT_COLORS = [
	"#3b6ea8",
	"#d9466f",
	"#2f9e5f",
	"#e2742b",
	"#7a4fc0",
	"#2d9bb0",
	"#c9a227",
	"#5d6b78",
	"#c55aa0",
	"#8a6a4f",
];

const textPresets = (prefix, chars) =>
	[...chars].map((text, i) => ({
		id: `${prefix}-${text.toLowerCase()}`,
		color: TEXT_COLORS[i % TEXT_COLORS.length],
		text,
	}));

export const PRESET_GROUPS = [
	{ label: "記号", presets: SYMBOLS },
	{
		label: "アルファベット",
		presets: textPresets("letter", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
	},
	{ label: "数字", presets: textPresets("digit", "0123456789") },
];

const byId = new Map(
	PRESET_GROUPS.flatMap((g) => g.presets).map((p) => [p.id, p]),
);

export function hasPreset(id) {
	return byId.has(id);
}

export function presetIcon(id) {
	const p = byId.get(id);
	const span = document.createElement("span");
	span.className = "icon preset";
	span.style.background = p.color;
	span.innerHTML = p.text
		? `<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="12.5">${p.text}</text></svg>`
		: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${p.d}"/></svg>`;
	return span;
}
