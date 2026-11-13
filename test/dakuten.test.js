if (typeof globalThis.matchMedia === "undefined") {
	globalThis.matchMedia = () => ({
		matches: false,
		addEventListener: () => {},
	});
}
if (typeof globalThis.localStorage === "undefined") {
	globalThis.localStorage = { getItem: () => null, setItem: () => {} };
}
if (typeof globalThis.document === "undefined") {
	const makeEl = () => ({
		append: () => {},
		after: () => {},
		replaceChildren: () => {},
		addEventListener: () => {},
		querySelector: () => ({ addEventListener: () => {} }),
		querySelectorAll: () => [],
		classList: { add: () => {}, remove: () => {} },
		style: { setProperty: () => {} },
	});
	globalThis.document = {
		querySelector: () => null,
		createElement: makeEl,
	};
}

import { test } from "node:test";
import assert from "node:assert/strict";

const { composeKanaDakuten, FONTS } = await import("../public/reader.js");

test("ひらがなに続く濁点・半濁点が結合用文字になる", () => {
	assert.equal(composeKanaDakuten("あ゛"), "あ\u3099");
	assert.equal(composeKanaDakuten("い゛"), "い\u3099");
	assert.equal(composeKanaDakuten("ん゛"), "ん\u3099");
	assert.equal(composeKanaDakuten("ぁ゛"), "ぁ\u3099");
	assert.equal(composeKanaDakuten("あ゜"), "あ\u309A");
	assert.equal(composeKanaDakuten("な゜"), "な\u309A");
});

test("カタカナに続く濁点・半濁点が結合用文字になる", () => {
	assert.equal(composeKanaDakuten("ア゛"), "ア\u3099");
	assert.equal(composeKanaDakuten("エ゛"), "エ\u3099");
	assert.equal(composeKanaDakuten("ン゛"), "ン\u3099");
	assert.equal(composeKanaDakuten("ァ゛"), "ァ\u3099");
	assert.equal(composeKanaDakuten("ア゜"), "ア\u309A");
	assert.equal(composeKanaDakuten("ワ゜"), "ワ\u309A");
	assert.equal(composeKanaDakuten("ㇰ゛"), "ㇰ\u3099");
});

test("半角の濁点・半濁点記号も結合用文字になる", () => {
	assert.equal(composeKanaDakuten("あﾞ"), "あ\u3099");
	assert.equal(composeKanaDakuten("アﾟ"), "ア\u309A");
});

test("長音符や踊り字に続く濁点・半濁点も結合用文字になる", () => {
	assert.equal(composeKanaDakuten("ー゛"), "ー\u3099");
	assert.equal(composeKanaDakuten("ゝ゛"), "ゝ\u3099");
	assert.equal(composeKanaDakuten("ヽ゛"), "ヽ\u3099");
});

test("仮名以外の文字に続く濁点・半濁点はそのまま残る", () => {
	assert.equal(composeKanaDakuten("漢゛"), "漢゛");
	assert.equal(composeKanaDakuten("1゛"), "1゛");
	assert.equal(composeKanaDakuten("A゛"), "A゛");
	assert.equal(composeKanaDakuten("！゛"), "！゛");
});

test("すでに結合用濁点・半濁点が含まれる場合は二重に変換されない", () => {
	assert.equal(composeKanaDakuten("あ\u3099"), "あ\u3099");
	assert.equal(composeKanaDakuten("ア\u309A"), "ア\u309A");
});

test("FONTS に mincho, rinmincho, gothic の3種類が定義されている", () => {
	assert.deepEqual(Object.keys(FONTS), ["mincho", "rinmincho", "gothic"]);
	assert.match(FONTS.rinmincho.family, /"RinMincho"/);
});

test("Reader で rinmincho のときは濁点が合成され、それ以外のフォントでは変換されない", async () => {
	const { Reader } = await import("../public/reader.js");
	const dummyEl = {
		querySelector: () => ({ addEventListener: () => {} }),
		querySelectorAll: () => [],
		style: { setProperty: () => {} },
		classList: { add: () => {}, remove: () => {} },
		addEventListener: () => {},
	};
	const dummyPageEl = {
		clientWidth: 800,
		clientHeight: 600,
		getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
		append: () => {},
		after: () => {},
	};
	dummyEl.querySelector = (sel) => {
		if (sel === ".page") return dummyPageEl;
		if (sel === ".content") return { style: { setProperty: () => {} } };
		if (sel === ".status") return {};
		if (sel === ".changes")
			return {
				querySelector: () => ({ addEventListener: () => {} }),
				addEventListener: () => {},
			};
		return null;
	};

	const reader = new Reader(dummyEl);
	reader.content = { innerHTML: "", style: { setProperty: () => {} } };
	reader.path = "test.txt";

	// 1. mincho のときはそのまま
	reader.font = "mincho";
	reader.render("あ゛！　エ゛！", 100);
	assert.match(reader.content.innerHTML, /あ゛！/);
	assert.doesNotMatch(reader.content.innerHTML, /あ\u3099/);

	// 2. rinmincho のときは結合用濁点に合成される
	reader.font = "rinmincho";
	reader.render("あ゛！　エ゛！", 100);
	assert.match(reader.content.innerHTML, /あ\u3099！/);
	assert.doesNotMatch(reader.content.innerHTML, /あ゛！/);
});
