/**
 * この実行環境でスクレイパー(Playwright + Chromium)が動くかを判定する。
 *
 * Vercel などのサーバーレス環境ではChromiumを起動できないため、
 * 「起動してから落ちる」のではなく、事前に分かる形で止める。
 * 画面側もこの判定を見て、押せないボタンではなく理由を表示する。
 */

export type ScraperEnvironment = {
  available: boolean;
  /** 使えない場合の、利用者に見せる理由 */
  reason?: string;
  /** どう回避すればよいかの案内 */
  hint?: string;
};

let cached: ScraperEnvironment | null = null;

export function checkScraperEnvironment(): ScraperEnvironment {
  if (cached) return cached;

  // Vercel / AWS Lambda 判定。どちらもファイルシステムと実行時間の制約で
  // ヘッドレスChromiumを常駐起動できない。
  const isServerless =
    process.env.VERCEL === "1" ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.NEXT_RUNTIME === "edge");

  if (isServerless) {
    cached = {
      available: false,
      reason: "この環境(Vercelなどのサーバーレス)ではヘッドレスブラウザを起動できません。",
      hint:
        "スクレイピングは常駐サーバー(お手元のPCやVPS)で `npm run scrape:search` などのコマンドから実行してください。" +
        "取得結果は同じSupabaseに入るので、この画面にそのまま反映されます。",
    };
    return cached;
  }

  // playwright 本体が入っているか(依存を軽くするために外している構成もありうる)
  try {
    require.resolve("playwright");
  } catch {
    cached = {
      available: false,
      reason: "playwright がインストールされていません。",
      hint: "`npm install` と `npx playwright install chromium` を実行してください。",
    };
    return cached;
  }

  cached = { available: true };
  return cached;
}

/** Chromium の実体まで確認する(起動直前のチェック用) */
export async function assertScraperUsable(): Promise<void> {
  const env = checkScraperEnvironment();
  if (!env.available) throw new Error(`${env.reason} ${env.hint ?? ""}`.trim());
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    if (!path) throw new Error("実行ファイルのパスが取れませんでした");
  } catch (e) {
    throw new Error(
      "Chromium が見つかりません。`npx playwright install chromium` を実行してください。" +
        ` (${String(e).slice(0, 120)})`
    );
  }
}
