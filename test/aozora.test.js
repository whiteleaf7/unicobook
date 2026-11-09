import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAozora, decodeText, plainLine, countAozoraCharacters, calculateReadingMetrics } from '../public/aozora.js';

const line = (src) => parseAozora(src).replace(/^<p data-l="0"[^>]*>|<\/p>$/g, '');

test('漢字の直前にルビを付ける', () => {
  assert.equal(line('今日は東京《とうきょう》へ'), '今日は<ruby>東京<rt>とうきょう</rt></ruby>へ');
});

test('｜でルビの範囲を指定する', () => {
  assert.equal(line('｜あの人《ひと》だ'), '<ruby>あの人<rt>ひと</rt></ruby>だ');
});

test('カタカナの直前にもルビを付ける', () => {
  assert.equal(line('あのマナ《まりょく》が'), 'あの<ruby>マナ<rt>まりょく</rt></ruby>が');
});

test('ルビの親文字がなければそのまま表示する', () => {
  assert.equal(line('「《》」'), '「《》」');
});

test('前方参照の見出しを付ける', () => {
  assert.equal(line('１話　月曜日［＃「１話　月曜日」は中見出し］'), '<span class="h-mid">１話　月曜日</span>');
});

test('縦中横の範囲指定', () => {
  assert.equal(line('「いたの［＃縦中横］!?［＃縦中横終わり］'), '「いたの<span class="tcy">!?</span>');
});

test('前方参照の縦中横', () => {
  assert.equal(line('第12［＃「12」は縦中横］話'), '第<span class="tcy">12</span>話');
});

test('段階付きの小さな文字を「小さな文字終わり」で閉じる', () => {
  assert.equal(line('［＃２段階小さな文字］注［＃小さな文字終わり］'), '<span style="font-size:0.714em">注</span>');
});

test('ルビを含む文字列に前方参照の傍点を付ける', () => {
  const html = line('東京《とうきょう》だ［＃「東京だ」に傍点］');
  assert.match(html, /^<span class="em"[^>]*><ruby>東京<rt>とうきょう<\/rt><\/ruby>だ<\/span>$/);
});

test('「X」に「Y」のルビ', () => {
  assert.equal(line('明日［＃「明日」に「あした」のルビ］'), '<ruby>明日<rt>あした</rt></ruby>');
});

test('行頭の地付きは行全体を下に寄せる', () => {
  assert.equal(parseAozora('［＃地付き］おわり'), '<p data-l="0" style="text-align:end">おわり</p>');
});

test('行の途中の地付きは後ろだけを下に寄せる', () => {
  assert.equal(
    parseAozora('題［＃「題」は中見出し］［＃地付き］作者'),
    '<p data-l="0" class="split"><span><span class="h-mid">題</span></span><span>作者</span></p>',
  );
});

test('字下げと折り返し', () => {
  assert.equal(parseAozora('［＃３字下げ］本文'), '<p data-l="0" style="padding-inline-start:3em">本文</p>');
  const html = parseAozora('［＃ここから２字下げ、折り返して４字下げ］\n本文\n［＃ここで字下げ終わり］\n次');
  assert.equal(
    html,
    '<p data-l="1" style="padding-inline-start:4em;text-indent:-2em">本文</p>\n<p data-l="3">次</p>',
  );
});

test('挿絵は画像のブロックになり、相対パスを解決する', () => {
  const html = parseAozora('前\n［＃挿絵（fig1.jpg）入る］\n後', (p) => `/img/${p}`);
  assert.equal(html, '<p data-l="0">前</p>\n<img class="fig" data-l="1" src="/img/fig1.jpg" alt="">\n<p data-l="2">後</p>');
});

test('青空文庫形式の画像注記', () => {
  const html = parseAozora('［＃石の図（img/fig01.png、横200×縦100）入る］');
  assert.match(html, /src="img\/fig01.png"/);
});

test('改ページ', () => {
  assert.equal(parseAozora('前\n［＃改ページ］\n後'), '<p data-l="0">前</p>\n<div class="pb"></div>\n<p data-l="2">後</p>');
});

test('空行は <br> を入れて幅を保つ', () => {
  assert.equal(parseAozora(''), '<p data-l="0"><br></p>');
});

test('連続したダッシュを 1 本の線にする', () => {
  assert.equal(line('で、――ナイ'), 'で、<span class="dash" style="--n:2">――</span>ナイ');
  assert.equal(line('あ―い'), 'あ―い');
});

test('注記のない半角の「!」「?」を立てる', () => {
  assert.equal(line('ないわよ!!」'), 'ないわよ<span class="tcy">!!</span>」');
  assert.equal(line('えっ!'), 'えっ<span class="tcy">!</span>');
  assert.equal(line('嘘!!!'), '嘘<span class="upright">!!!</span>');
  assert.equal(line('全角は！！そのまま'), '全角は！！そのまま');
});

test('縦中横の注記と自動の縦中横が二重にならない', () => {
  assert.equal(line('「こらっ!!［＃「!!」は縦中横］'), '「こらっ<span class="tcy">!!</span>');
  assert.equal(line('えっ［＃縦中横］!?［＃縦中横終わり］'), 'えっ<span class="tcy">!?</span>');
});

test('注記のない 1〜2 桁の半角数字を縦中横にする', () => {
  assert.equal(line('10時に'), '<span class="tcy">10</span>時に');
  assert.equal(line('第3話'), '第<span class="tcy">3</span>話');
  assert.equal(line('2026年'), '2026年');
  assert.equal(line('Gemini 3.8 Flash'), 'Gemini 3.8 Flash');
  assert.equal(line('fable5'), 'fable5');
  assert.equal(line('第12［＃「12」は縦中横］話'), '第<span class="tcy">12</span>話');
});

test('ダッシュの長さの指定を数字として扱わない', () => {
  assert.equal(line('――'), '<span class="dash" style="--n:2">――</span>');
});

test('検索用にルビの読みと注記を除く', () => {
  assert.equal(plainLine('｜あの人《ひと》は東京《とうきょう》へ［＃「へ」に傍点］'), 'あの人は東京へ');
  assert.equal(plainLine('《《強調》》だ'), '強調だ');
  assert.equal(plainLine('｜あのね《rt》'), 'あのね');
  assert.equal(plainLine('……《ファイアボール》'), '……《ファイアボール》');
});

test('HTML をエスケープする', () => {
  assert.equal(line('<b>&'), '&lt;b&gt;&amp;');
});

test('外字注記', () => {
  assert.equal(line('※［＃「てへん＋劣」、U+6318、123-4］'), '挘');
  assert.equal(line('※［＃「口＋世」、第3水準1-14-87］'), '<span class="gaiji">［口＋世］</span>');
});

test('記号説明ブロックを取り除く', () => {
  const src = '題名\n作者\n\n-------------------------------------------------------\n【テキスト中に現れる記号について】\n\n《》：ルビ\n-------------------------------------------------------\n本文';
  const html = parseAozora(src);
  assert.doesNotMatch(html, /記号について/);
  assert.match(html, /本文/);
});

test('UTF-8 と Shift_JIS を判定する', () => {
  assert.equal(decodeText(new TextEncoder().encode('縦書き')), '縦書き');
  const sjis = new Uint8Array([0x8f, 0x63, 0x8f, 0x91, 0x82, 0xab]);
  assert.equal(decodeText(sjis), '縦書き');
});

test('本文の文字数を正しくカウントする（空白・改行・ルビ・注記を除く）', () => {
  const src = `
題名［＃「題名」は大見出し］
　今日は東京《とうきょう》へ　行った。
｜あの方《かた》もいた。
`;
  // 「題名」「今日は東京へ行った。」「あの方もいた。」
  // 題名(2) + 今日は東京へ行った。(10) + あの方もいた。(7) = 19文字
  assert.equal(countAozoraCharacters(src), 19);
});

test('読了メトリクス（原稿用紙換算枚数・読了目安時間）を計算する', () => {
  const empty = calculateReadingMetrics('');
  assert.deepEqual(empty, { chars: 0, manuscriptPages: 0, readingMinutes: 0 });

  // 1000文字のテキスト
  const text = 'あ'.repeat(1000);
  const metrics = calculateReadingMetrics(text);
  assert.equal(metrics.chars, 1000);
  assert.equal(metrics.manuscriptPages, 3); // ceil(1000 / 400) = 3
  assert.equal(metrics.readingMinutes, 2); // round(1000 / 500) = 2
});
