/**
 * 画面からスクレイパーを起動するAPI。
 *   POST /api/scrape  { kind: "search" | "seller" | "sourcing", ... }  → { jobId }
 *   GET  /api/scrape?id=<jobId>                                        → ジョブの状態とログ
 *
 * 注意: Playwrightは常駐サーバー(ローカル / VPS / Docker)でしか動きません。
 *       Vercelなどのサーバーレスにデプロイした場合、この経路は使えないので
 *       CLI (npm run scrape:*) を常駐マシンで実行してください。
 */
import { NextRequest, NextResponse } from "next/server";
import { appendLog, createJob, finishJob, getJob, setProgress } from "../../../lib/jobs";
import { BlockedError, parseSourcingModes } from "../../../lib/scraper/types";
import { normalizeSellerId } from "../../../lib/scraper/seller-id";
import { checkScraperEnvironment } from "../../../lib/scraper/environment";
import { currentUser } from "../../../lib/auth";

/**
 * ログインしている人だけが実行できる。
 *
 * middleware はCookieの有無しか見ていないので、APIの入口でも必ず確認する。
 * 画面(レイアウト)を通らずに直接叩かれる経路だから、ここが抜けると素通しになる。
 */
async function denyIfSignedOut() {
  const user = await currentUser().catch(() => null);
  if (user) return null;
  return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
}

export const dynamic = "force-dynamic";
// Vercelの上限を超えるとデプロイが失敗する(Hobby=60秒 / Pro=300秒)。
// スクレイピング自体はレスポンスを待たせずバックグラウンドで走るので、
// このハンドラ自体は数秒で返れば足りる。
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = await denyIfSignedOut();
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id");
  // id なしの場合は「この環境でスクレイパーが使えるか」を返す
  if (!id) return NextResponse.json(checkScraperEnvironment());
  const job = getJob(id);
  if (!job) {
    return NextResponse.json(
      { error: "ジョブが見つかりません(サーバー再起動後は履歴が消えます)" },
      { status: 404 }
    );
  }
  return NextResponse.json(job);
}

export async function POST(req: NextRequest) {
  const denied = await denyIfSignedOut();
  if (denied) return denied;

  const env = checkScraperEnvironment();
  if (!env.available) {
    return NextResponse.json({ error: `${env.reason} ${env.hint ?? ""}`.trim() }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = String(body.kind ?? "");

  if (kind === "search") {
    const { parseSearchWords, formatKeywordsLabel, MAX_SEARCH_KEYWORDS, MAX_ARUARU_WORDS } = await import(
      "../../../lib/scraper/search-words"
    );
    // キーワードはスペース/カンマ区切りで最大10件。複数あるとそれぞれ検索して結果をまとめる
    const keywords = parseSearchWords(body.keyword ?? body.keywords, { max: MAX_SEARCH_KEYWORDS });
    if (!keywords.length) {
      return NextResponse.json({ error: "キーワードを入力してください" }, { status: 400 });
    }
    const aruaru = parseSearchWords(body.aruaru, { max: MAX_ARUARU_WORDS });
    const pages = clamp(Number(body.pages ?? 2), 1, 10);
    const sellerLimit = clamp(Number(body.sellers ?? body.resolve ?? 60), 1, 200);
    const includeUsed = Boolean(body.includeUsed);
    const label = formatKeywordsLabel(keywords);
    const job = createJob("search", `「${label}」のSOLD検索`);
    void runSearch(job.id, keywords, aruaru, pages, sellerLimit, includeUsed);
    return NextResponse.json({ jobId: job.id });
  }

  if (kind === "seller") {
    // プロフィールURLを貼られても動くようにする(/api/jobs・CLIと同じ関数を通す)
    const sellerExternalId = normalizeSellerId(String(body.seller_external_id ?? ""));
    if (!sellerExternalId) return NextResponse.json({ error: "セラーIDが必要です" }, { status: 400 });
    const max = clamp(Number(body.max ?? 100), 1, 300);
    const shipping = clamp(Number(body.shipping ?? 3), 0, 20);
    const job = createJob("seller", `セラー ${sellerExternalId} の再取得`);
    void runSeller(job.id, sellerExternalId, max, shipping);
    return NextResponse.json({ jobId: job.id });
  }

  if (kind === "sourcing") {
    const groupId = Number(body.product_group_id);
    if (!groupId) return NextResponse.json({ error: "product_group_id が必要です" }, { status: 400 });
    const modes = parseSourcingModes(body.modes);
    if (!modes.length) {
      return NextResponse.json({ error: "探し方(タイトル/画像)を1つ以上選んでください" }, { status: 400 });
    }
    const job = createJob("sourcing", `仕入れ候補の検索 (#${groupId})`);
    void runSourcing(job.id, groupId, Boolean(body.apply), modes);
    return NextResponse.json({ jobId: job.id });
  }

  return NextResponse.json({ error: `未知の kind: ${kind}` }, { status: 400 });
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;
}


/** BlockedError を分かりやすい日本語にしてジョブを終わらせる */
function fail(jobId: string, e: unknown) {
  if (e instanceof BlockedError) {
    appendLog(jobId, `[中断] ${e.message}`);
    appendLog(jobId, `  URL: ${e.url}`);
    appendLog(jobId, "  時間をおいてから、アクセス間隔を広げて再実行してください。");
    finishJob(jobId, { status: "error", error: e.message });
  } else {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 400);
    appendLog(jobId, `[エラー] ${msg}`);
    finishJob(jobId, { status: "error", error: msg });
  }
}

async function runSearch(
  jobId: string,
  keywords: string[],
  aruaru: string[],
  pages: number,
  sellerLimit: number,
  includeUsed: boolean
) {
  const log = (m: string) => appendLog(jobId, m);
  const { MercariScraper } = await import("../../../lib/scraper/mercari");
  const { createSearch, saveListings, saveSellerResults, upsertSellers } = await import("../../../lib/scraper/persist");
  const { aggregateBySeller } = await import("../../../lib/engine/aggregate");
  const { formatKeywordsLabel, buildSearchQueries } = await import("../../../lib/scraper/search-words");
  // ページ送りは5秒間隔。参考にした既存サービスの実測値に合わせている
  const scraper = new MercariScraper({ minIntervalMs: 5000, log });
  try {
    await scraper.start();
    const label = formatKeywordsLabel(keywords);
    const queryCount = buildSearchQueries(keywords, aruaru).length;
    log(
      `検索を開始します: 「${label}」` +
        (aruaru.length ? ` + [${aruaru.join(", ")}]` : "") +
        `（${keywords.length}語 → ${queryCount}クエリ）`
    );

    const listings = await scraper.searchSold(keywords, aruaru, pages, {
      includeUsed,
      onPage: ({ query, page, pages: n, total }) => {
        log(`  [${query}] ${page}/${n}ページ … 累計${total}件`);
        setProgress(jobId, { phase: "crawl", done: page, total: n, label: `${query} · 累計${total}件` });
      },
    });
    if (!listings.length) {
      log("該当する出品を取得できませんでした。");
      finishJob(jobId, { status: "done" });
      return;
    }

    setProgress(jobId, { phase: "aggregate" });
    const stats = aggregateBySeller(
      listings.map((l) => ({
        seller_external_id: l.seller_external_id,
        price: l.price,
        listed_at: l.listed_at,
        updated_at: l.updated_at,
        is_new: l.is_new,
        category_id: null,
        matched_keyword: l.matched_keyword,
      })),
      { includeUsed }
    );
    log(`集計: 出品${listings.length}件 / セラー${stats.length}人`);

    const top = stats.slice(0, sellerLimit);
    log(`セラー名を取得します(上位${top.length}人)`);
    const profiles = await scraper.resolveSellerNames(
      top.map((s) => s.seller_external_id),
      {
        onProgress: (done, total, name) => {
          if (done % 10 === 0 || done === total) log(`  ${done}/${total}人`);
          setProgress(jobId, { phase: "names", done, total, label: name });
        },
      }
    );
    // 名前が取れなかったセラーもIDだけで登録する
    for (const s of top) {
      if (profiles.has(s.seller_external_id)) continue;
      profiles.set(s.seller_external_id, {
        platform: "mercari",
        seller_external_id: s.seller_external_id,
        seller_name: s.seller_external_id,
        rating: null,
        review_count: null,
        profile_url: scraper.profileUrl(s.seller_external_id),
      });
    }

    setProgress(jobId, { phase: "save" });
    const keep = new Set(top.map((s) => s.seller_external_id));
    const searchId = await createSearch(keywords, aruaru);
    const sellerIds = await upsertSellers(profiles);
    await saveListings(
      listings.filter((l) => keep.has(l.seller_external_id)),
      profiles,
      log
    );
    await saveSellerResults(searchId, top, sellerIds, log);
    log("完了しました。");
    finishJob(jobId, { status: "done", resultHref: "/" });
  } catch (e) {
    fail(jobId, e);
  } finally {
    await scraper.close();
  }
}

/**
 * 3-2: セラー深掘り。
 *
 * 中身は lib/scraper/seller-run.ts にある(ワーカーとCLIからも同じ処理を使うため)。
 * ここは「ジョブのログと進捗に流し込む」だけを担当する。
 */
async function runSeller(jobId: string, sellerExternalId: string, max: number, shippingTop: number) {
  const log = (m: string) => appendLog(jobId, m);
  try {
    const { runSellerDeepdive } = await import("../../../lib/scraper/seller-run");
    const result = await runSellerDeepdive({
      sellerExternalId,
      maxItems: max,
      shippingTop,
      log,
      onPhase: (p) =>
        setProgress(jobId, { phase: p.phase, done: p.done, total: p.total, label: p.label }),
    });
    // 出品0件は失敗ではない(セラーIDの取り違えか、出品を全部取り下げた状態)
    if (!result.listings) {
      finishJob(jobId, { status: "done" });
      return;
    }
    log("完了しました。");
    finishJob(jobId, { status: "done", resultHref: result.result_href ?? undefined });
  } catch (e) {
    fail(jobId, e);
  }
}


/**
 * 3-3: 仕入れ候補の検索。
 *
 * 中身は lib/scraper/sourcing-run.ts にある(ワーカーとCLIからも同じ処理を使うため)。
 * ここは「ジョブのログと進捗に流し込む」だけを担当する。
 */
async function runSourcing(
  jobId: string,
  groupId: number,
  apply: boolean,
  modes: ("title" | "image")[]
) {
  const log = (m: string) => appendLog(jobId, m);
  try {
    const { runSourcing: run } = await import("../../../lib/scraper/sourcing-run");
    await run({
      productGroupId: groupId,
      modes,
      apply,
      log,
      onPhase: (p) =>
        setProgress(jobId, { phase: p.phase, done: p.done, total: p.total, label: p.label }),
    });
    log("完了しました。");
    finishJob(jobId, { status: "done", resultHref: "/deepdive-list" });
  } catch (e) {
    fail(jobId, e);
  }
}
