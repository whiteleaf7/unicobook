// OS ごとに違う処理の判定と、パスの既定値。テストで OS を差し替えられるよう、どれも引数で OS を受け取る。
// config.ts は読み込んだ時点で設定を確かめて終了することがあるので、ここには副作用を持たせない
import path from "node:path";

// macOS（darwin）を基本とし、Linux だけ別の処理にする（ほかの OS は従来どおり macOS と同じ扱い）
export type Os = "darwin" | "linux";

export function detectOs(platform: string): Os {
	return platform === "linux" ? "linux" : "darwin";
}

// サーバーが動いている OS
export const OS: Os = detectOs(process.platform);

// 作業ファイルとユーザーデータの置き場所の既定値（環境変数で指定されていれば、そちらが優先される）。
// 値は ~ で始まってよい（config.ts がホームディレクトリに置き換える）
export function defaultDirs(
	os: Os,
	env: Record<string, string | undefined> = process.env,
): { cacheDir: string; dataDir: string } {
	if (os === "darwin") {
		return {
			cacheDir: "~/Library/Caches/unicobook",
			dataDir: "~/Library/Application Support/unicobook",
		};
	}
	// Linux は XDG Base Directory に従う。仕様どおり、絶対パスでない値は無視する
	const xdg = (name: string, fallback: string) => {
		const value = env[name]?.trim();
		return path.join(
			value && path.isAbsolute(value) ? value : fallback,
			"unicobook",
		);
	};
	return {
		cacheDir: xdg("XDG_CACHE_HOME", "~/.cache"),
		dataDir: xdg("XDG_DATA_HOME", "~/.local/share"),
	};
}
