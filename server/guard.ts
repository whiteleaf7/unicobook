// このアプリは自分のサイトだけで完結するので、別のサイトからのリクエストは弾く。
// - Host: DNS rebinding（攻撃者のドメインが 127.0.0.1 を指す）を防ぐため、想定したホスト名だけ受け付ける
// - Sec-Fetch-Site / Origin: 別のサイトのページから飛んでくるリクエスト（CSRF や読み取り）を防ぐ

import type { IncomingHttpHeaders } from 'node:http';

// ローカルと tailscale serve（<マシン名>.<tailnet>.ts.net）のホスト名。追加したいときは UNICOBOOK_ALLOWED_HOSTS にカンマ区切りで指定する
const EXTRA_HOSTS = (process.env.UNICOBOOK_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function hostnameOf(host: string): string {
  const h = host.toLowerCase();
  // IPv6 リテラルは [::1]:8787 の形
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d*$/, '');
}

export function isAllowedHost(host: string | undefined, extraHosts: string[] = EXTRA_HOSTS): boolean {
  if (!host) return false;
  const name = hostnameOf(host);
  return (
    name === 'localhost' ||
    name === '127.0.0.1' ||
    name === '[::1]' ||
    name.endsWith('.ts.net') ||
    extraHosts.includes(name)
  );
}

/** 受け付けてはいけないリクエストなら理由を、問題なければ null を返す */
export function rejectReason(method: string | undefined, headers: IncomingHttpHeaders, extraHosts?: string[]): string | null {
  if (!isAllowedHost(headers.host, extraHosts)) return 'forbidden host';

  // Origin は POST や別オリジンへの fetch に付く。同じサイト（Host と同じ）からのものだけ通す
  const origin = headers.origin;
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return 'forbidden origin';
    }
    if (originHost !== headers.host) return 'forbidden origin';
  }

  // Sec-Fetch-Site は最近のブラウザが必ず付ける。same-origin か、URL 直打ち・ブックマーク・ホーム画面から開く none だけ通す。
  // 別のサイトからのリンクで画面を開く（GET の navigate）だけは、中身を読まれないので許す
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    const isNavigation = headers['sec-fetch-mode'] === 'navigate' && (method === 'GET' || method === 'HEAD');
    if (!isNavigation) return 'forbidden cross-site request';
  }

  return null;
}
