// Antigravity の CLI（agy）で、サブスクの Gemini に文章や画像を作ってもらう
import { execFile } from 'node:child_process';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AGY, AGY_BRAIN_DIR, AGY_MODEL, AGY_WORK_DIR } from './config.ts';

const execFileAsync = promisify(execFile);
const GENERATED_IMAGE = /\.(png|jpe?g|webp)$/i;

// agy にプロンプトを渡して、返事と会話 ID を返す。
// timeoutSec は agy に伝える制限時間で、killAfterMs を過ぎても終わらなければ止めて timeoutMessage のエラーにする
async function runAgy(prompt: string, { timeoutSec, killAfterMs, timeoutMessage }: { timeoutSec: number; killAfterMs: number; timeoutMessage: string }) {
  await mkdir(AGY_WORK_DIR, { recursive: true });
  const args = [
    '--print',
    prompt,
    '--model',
    AGY_MODEL,
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--sandbox',
    '--print-timeout',
    `${timeoutSec}s`,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(AGY, args, { cwd: AGY_WORK_DIR, timeout: killAfterMs, maxBuffer: 10 * 1024 * 1024 }));
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') throw new Error(`agy が見つかりません（${AGY}）`);
    if (err.killed) throw new Error(timeoutMessage);
    throw new Error(`agy が失敗しました: ${(err.stderr ?? '').trim().slice(-300) || `終了コード ${err.code}`}`);
  }
  let result: { conversation_id?: string; response?: string } = {};
  try {
    result = JSON.parse(stdout);
  } catch {
    // JSON でなければ、出力をそのまま返事とみなす
  }
  return { response: (result.response ?? stdout).trim(), conversationId: result.conversation_id };
}

// 文章を作ってもらい、返事（Markdown）を返す
export async function askAgy(prompt: string): Promise<string> {
  const { response } = await runAgy(prompt, { timeoutSec: 180, killAfterMs: 200_000, timeoutMessage: '時間内に生成が終わりませんでした' });
  if (!response) throw new Error('返答が得られませんでした');
  return response;
}

// 画像を作ってもらい、できた画像のパスを返す
export async function generateImageWithAgy(prompt: string): Promise<string> {
  const { response, conversationId } = await runAgy(prompt, { timeoutSec: 300, killAfterMs: 330_000, timeoutMessage: '時間内に作り終わりませんでした' });
  // パスだけと頼んでも前置きを付けてくることがあるので、パスらしい最後の行を使う
  const pathLine =
    response
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => path.isAbsolute(line)) ?? '';
  const image = (await generatedImage(pathLine)) ?? (conversationId && (await latestGeneratedImage(conversationId)));
  if (!image) throw new Error(`画像ができませんでした: ${response.slice(0, 300)}`);
  return image;
}

// 返事に書かれたパスが、agy の作った画像なら実パスを返す（返事のパスのファイルを何でも読んでしまわないよう、brain の下に限る）
async function generatedImage(file: string): Promise<string | null> {
  if (!path.isAbsolute(file) || !GENERATED_IMAGE.test(file)) return null;
  const real = await realpath(file).catch(() => null);
  const brain = await realpath(AGY_BRAIN_DIR).catch(() => null);
  if (!real || !brain || !real.startsWith(brain + path.sep)) return null;
  return (await stat(real)).isFile() ? real : null;
}

// 返事がパスになっていなかったときのために、その会話で作られたいちばん新しい画像を探す
async function latestGeneratedImage(conversationId: string): Promise<string | null> {
  if (!/^[0-9a-f-]+$/i.test(conversationId)) return null;
  const dir = path.join(AGY_BRAIN_DIR, conversationId);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let latest: { file: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isFile() || !GENERATED_IMAGE.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const { mtimeMs } = await stat(file);
    if (!latest || mtimeMs > latest.mtime) latest = { file, mtime: mtimeMs };
  }
  return latest?.file ?? null;
}
