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

const { Reader } = await import("../public/reader.js");

function createDummyReader(options = {}) {
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

	const reader = new Reader(dummyEl, options);
	reader.content = { style: { setProperty: () => {} } };
	reader.marksEl = { style: { setProperty: () => {} } };
	reader.notesEl = { style: { setProperty: () => {} } };
	reader.statusEl = { textContent: "" };
	reader.decodeNearbyImages = () => {};
	reader.updateNavGuide = () => {};
	reader.saveLater = () => {};
	return reader;
}

test("next: 話の途中で進むときは次のページに進み、page を返す", () => {
	const reader = createDummyReader();
	reader.pages = 3;
	reader.page = 0;
	const res = reader.next();
	assert.equal(res, "page");
	assert.equal(reader.page, 1);
});

test("next: allowEpisode: false でも話の途中ならページ移動できる", () => {
	const reader = createDummyReader();
	reader.pages = 3;
	reader.page = 1;
	const res = reader.next({ allowEpisode: false });
	assert.equal(res, "page");
	assert.equal(reader.page, 2);
});

test("next: 最後のページで allowEpisode: false のときは移動せず false を返す", () => {
	let navigated = false;
	const reader = createDummyReader({
		onNavigateEpisode: () => {
			navigated = true;
		},
	});
	reader.pages = 3;
	reader.page = 2;
	reader.nextEpisode = { href: "#/r/next" };

	const res = reader.next({ allowEpisode: false });
	assert.equal(res, false);
	assert.equal(reader.page, 2);
	assert.equal(navigated, false);
});

test("next: 最後のページで allowEpisode: true（またはデフォルト）のときはエピソード移動する", () => {
	let navigatedArgs = null;
	const reader = createDummyReader({
		onNavigateEpisode: (dir, ep) => {
			navigatedArgs = { dir, ep };
		},
	});
	reader.pages = 3;
	reader.page = 2;
	const nextEp = { href: "#/r/next" };
	reader.nextEpisode = nextEp;

	const res = reader.next();
	assert.equal(res, "episode");
	assert.deepEqual(navigatedArgs, { dir: "next", ep: nextEp });
});

test("prev: 話の途中で戻るときは前のページに戻り、page を返す", () => {
	const reader = createDummyReader();
	reader.pages = 3;
	reader.page = 2;
	const res = reader.prev();
	assert.equal(res, "page");
	assert.equal(reader.page, 1);
});

test("prev: allowEpisode: false でも話の途中ならページ移動できる", () => {
	const reader = createDummyReader();
	reader.pages = 3;
	reader.page = 1;
	const res = reader.prev({ allowEpisode: false });
	assert.equal(res, "page");
	assert.equal(reader.page, 0);
});

test("prev: 最初のページで allowEpisode: false のときは移動せず false を返す", () => {
	let navigated = false;
	const reader = createDummyReader({
		onNavigateEpisode: () => {
			navigated = true;
		},
	});
	reader.pages = 3;
	reader.page = 0;
	reader.prevEpisode = { href: "#/r/prev" };

	const res = reader.prev({ allowEpisode: false });
	assert.equal(res, false);
	assert.equal(reader.page, 0);
	assert.equal(navigated, false);
});

test("prev: 最初のページで allowEpisode: true（またはデフォルト）のときはエピソード移動する", () => {
	let navigatedArgs = null;
	const reader = createDummyReader({
		onNavigateEpisode: (dir, ep) => {
			navigatedArgs = { dir, ep };
		},
	});
	reader.pages = 3;
	reader.page = 0;
	const prevEp = { href: "#/r/prev" };
	reader.prevEpisode = prevEp;

	const res = reader.prev();
	assert.equal(res, "episode");
	assert.deepEqual(navigatedArgs, { dir: "prev", ep: prevEp });
});
