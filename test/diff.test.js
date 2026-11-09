import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedLines, lineHashes, detailedDiff, diffChars } from '../public/diff.js';

const diff = (a, b) => {
  const { changed, hunks } = changedLines(lineHashes(a.split('')), lineHashes(b.split('')));
  return { changed: [...changed].sort((p, q) => p - q), hunks };
};

test('同じなら変更なし', () => {
  assert.deepEqual(diff('abc', 'abc'), { changed: [], hunks: [] });
});

test('書き換えた行', () => {
  assert.deepEqual(diff('abcde', 'abXde'), { changed: [2], hunks: [2] });
});

test('追加した行', () => {
  assert.deepEqual(diff('abcde', 'abXYcde'), { changed: [2, 3], hunks: [2] });
});

test('削除した行は直後の行に印を付ける', () => {
  assert.deepEqual(diff('abcde', 'abde'), { changed: [2], hunks: [2] });
});

test('末尾を削除したときは最後の行に印を付ける', () => {
  assert.deepEqual(diff('abcde', 'abc'), { changed: [2], hunks: [2] });
});

test('離れた複数の変更', () => {
  assert.deepEqual(diff('abcdefghij', 'aXcdefghYj'), { changed: [1, 8], hunks: [1, 8] });
});

test('先頭と末尾の両方の変更', () => {
  assert.deepEqual(diff('abcdef', 'Xbcdefg'), { changed: [0, 6], hunks: [0, 6] });
});

test('全部書き換え', () => {
  assert.deepEqual(diff('abc', 'xyz').hunks, [0]);
});

test('長い本文でも離れた変更を見つける', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `行${i}`);
  const edited = [...lines];
  edited[10] = '変更';
  edited.splice(2000, 0, '追加');
  const { hunks } = changedLines(lineHashes(lines), lineHashes(edited));
  assert.deepEqual(hunks, [10, 2000]);
});

test('detailedDiff: 行の書き換え差分を取得できる', () => {
  const before = ['第一行', '第二行（旧）', '第三行'];
  const after = ['第一行', '第二行（新）', '第三行'];
  const hunks = detailedDiff(before, after);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].deleted, ['第二行（旧）']);
  assert.deepEqual(hunks[0].added, ['第二行（新）']);
});

test('detailedDiff: 複数箇所の追加と削除を取得できる', () => {
  const before = ['A', 'B', 'C', 'D'];
  const after = ['A', 'B-new', 'C', 'D', 'E'];
  const hunks = detailedDiff(before, after);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].deleted, ['B']);
  assert.deepEqual(hunks[0].added, ['B-new']);
  assert.deepEqual(hunks[1].deleted, []);
  assert.deepEqual(hunks[1].added, ['E']);
});

test('diffChars: 文字単位の変更・追加・削除を正しく検出する', () => {
  const before = '今日は良い天気だ';
  const after = '今日はとても良い天気ですね';
  const { before: bParts, after: aParts } = diffChars(before, after);

  // before: "今日は" (equal), "良い天気" (equal), "だ" (delete)
  assert.equal(bParts.map((p) => p.text).join(''), before);
  assert.deepEqual(bParts.find((p) => p.type === 'delete'), { type: 'delete', text: 'だ' });

  // after: "今日は" (equal), "とても" (insert), "良い天気" (equal), "ですね" (insert)
  assert.equal(aParts.map((p) => p.text).join(''), after);
  const inserts = aParts.filter((p) => p.type === 'insert');
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].text, 'とても');
  assert.equal(inserts[1].text, 'ですね');
});

test('diffChars: 片方が空または同一の場合', () => {
  const same = diffChars('テスト文字列', 'テスト文字列');
  assert.deepEqual(same.before, [{ type: 'equal', text: 'テスト文字列' }]);
  assert.deepEqual(same.after, [{ type: 'equal', text: 'テスト文字列' }]);

  const addOnly = diffChars('', '新規追加');
  assert.deepEqual(addOnly.before, []);
  assert.deepEqual(addOnly.after, [{ type: 'insert', text: '新規追加' }]);

  const delOnly = diffChars('削除された文字列', '');
  assert.deepEqual(delOnly.before, [{ type: 'delete', text: '削除された文字列' }]);
  assert.deepEqual(delOnly.after, []);
});
