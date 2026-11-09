import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedHost, rejectReason } from '../server/guard.ts';

const ok = (method, headers, extra) => assert.equal(rejectReason(method, headers, extra), null);
const ng = (method, headers, extra) => assert.notEqual(rejectReason(method, headers, extra), null);

test('Host はローカルと ts.net だけ許可する', () => {
  for (const h of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787', 'mymac.example-tailnet.ts.net', 'MYMAC.example-tailnet.ts.net']) {
    assert.equal(isAllowedHost(h, []), true, h);
  }
  for (const h of [undefined, '', 'evil.example.com', 'evil.example.com:8787', 'ts.net.evil.com', 'evilts.net.example']) {
    assert.equal(isAllowedHost(h, []), false, String(h));
  }
});

test('NOVELBOOK_ALLOWED_HOSTS で追加したホストを許可する', () => {
  assert.equal(isAllowedHost('novel.example.com', []), false);
  assert.equal(isAllowedHost('novel.example.com:443', ['novel.example.com']), true);
});

test('許可しない Host は弾く（DNS rebinding）', () => {
  ng('GET', { host: 'evil.example.com:8787' });
  ng('GET', {});
});

test('同じサイトからのリクエストは通す', () => {
  const host = 'mymac.example-tailnet.ts.net';
  ok('GET', { host, 'sec-fetch-site': 'same-origin' });
  ok('POST', { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' });
  ok('POST', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' });
});

test('URL 直打ち・ブックマーク・curl は通す', () => {
  ok('GET', { host: 'mymac.example-tailnet.ts.net', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' });
  ok('GET', { host: '127.0.0.1:8787' });
  ok('POST', { host: '127.0.0.1:8787' });
});

test('別のサイトからの Origin は弾く（CSRF）', () => {
  const host = '127.0.0.1:8787';
  ng('POST', { host, origin: 'https://evil.example.com' });
  ng('POST', { host, origin: 'null' });
  ng('POST', { host, origin: 'not a url' });
  ng('POST', { host, origin: 'http://127.0.0.1:9999' });
  ng('GET', { host, origin: 'https://evil.example.com' });
});

test('別のサイトからの fetch / 画像読み込み / POST は弾く', () => {
  const host = '127.0.0.1:8787';
  for (const site of ['cross-site', 'same-site']) {
    ng('GET', { host, 'sec-fetch-site': site, 'sec-fetch-mode': 'cors' });
    ng('GET', { host, 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' });
    ng('POST', { host, 'sec-fetch-site': site, 'sec-fetch-mode': 'navigate' });
  }
});

test('別のサイトのリンクから画面を開く GET の navigate は通す', () => {
  ok('GET', { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' });
});
