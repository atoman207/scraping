/**
 * スクレイピング・ワーカー
 *
 *   npm run worker
 *
 * Supabase の jobs テーブルを見張り、queued のジョブを1件ずつ実行する。
 * 実ブラウザ(Playwright)を使うので、**Vercelでは動かせない**。
 * PCやVPSなど、常駐できてブラウザを起動できる場所で動かすこと。
 *
 * 役割分担:
 *   画面(Vercel) … ジョブを1行入れる / 進捗をポーリングする
 *   ワーカー(ここ) … 実際にメルカリを巡回してDBへ書く
 *
 * 途中で落ちても、heartbeat が5分途絶えたジョブは別のワーカーが拾い直す
 * (supabase/migrations/004_jobs.sql の claim_job を参照)。
 */
import "./_env";
import os from "node:os";
import { claimJob, finishJob, updateProgress, type Job, type JobProgress } from "../lib/jobs-db";
import { MercariScraper } from "../lib/scraper/mercari";
import { createSearch, saveListings, saveSellerResults, upsertSellers } from "../lib/scraper/persist";
import { aggregateBySeller } from "../lib/engine/aggregate";
import { BlockedError } from "../lib/scraper/types";

const WORKER_ID = `${os.hostname()}-${process.pid}`;
/**
 * ジョブが無いときの待ち時間。
 *
 * ずっと5秒間隔で問い合わせると1日17,000回になり、DBがネットワーク越し(Supabase)だと
 * 転送量を無駄に使う。何も無い状態が続いたら少しずつ間隔を広げ、
 * ジョブを拾ったら最短に戻す。上限を1分に抑えているのは、
 * Supabase無料枠の「7日間アクセスが無いと自動停止」を確実に避けるため。
 */
const IDLE_MIN_MS = 5000;
const IDLE_MAX_MS = 60000;
let idleWaitMs = IDLE_MIN_MS;
/** ページ送りの間隔。短くするとブロックされやすくなる */
const PAGE_INTERVAL_MS = Number(process.env.SCRAPE_INTERVAL_MS ?? 5000);
/** ブロックされたあとの冷却時間 */
const COOLDOWN_MS = Number(process.env.SCRAPE_COOLDOWN_MS ?? 10 * 60 * 1000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toTimeString().slice(0, 8);

function stamp(m: string) {
  console.log(`[${now()}] ${m}`);
}

/** ジョブのログとコンソールの両方に出す */
function loggerFor(jobId: number) {
  return (m: string) => {
    stamp(`  ${m}`);
    void updateProgress(jobId, { appendLog: m }).catch(() => {});
  };
}

async function setPhase(jobId: number, progress: JobProgress) {
  await updateProgress(jobId, { progress }).catch(() => {});
}

// ---------------------------------------------------------------- 3-1
async function runSearch(job: Job) {
  const p = job.params as {
    keyword?: string;
    aruaru?: string[];
    pages?: number;
    sellers?: number;
    includeUsed?: boolean;
  };
  const keyword = String(p.keyword ?? "").trim();
  if (!keyword) throw new Error("キーワードが指定されていません");
  const aruaru = Array.isArray(p.aruaru) ? p.aruaru.filter(Boolean).map(String) : [];
  const pages = Math.min(Math.max(Number(p.pages ?? 10), 1), 20);
  const sellerLimit = Math.min(Math.max(Number(p.sellers ?? 60), 1), 200);
  const includeUsed = Boolean(p.includeUsed);

  const log = loggerFor(job.id);
  const scraper = new MercariScraper({ minIntervalMs: PAGE_INTERVAL_MS, log });
  try {
    await scraper.start();
    log(`検索を開始します: "${keyword}"${aruaru.length ? ` + [${aruaru.join(", ")}]` : ""}`);

    // --- 巡回 ---
    const listings = await scraper.searchSold(keyword, aruaru, pages, {
      includeUsed,
      onPage: ({ query, page, pages: n, total }) => {
        void setPhase(job.id, { phase: "crawl", i: page, n, label: `${query}（累計${total}件）` });
      },
    });
    if (!listings.length) {
      log("売れた出品が0件でした。");
      await finishJob(job.id, { status: "done", result: { listings: 0, sellers: 0 } });
      return;
    }

    // --- 集計 ---
    await setPhase(job.id, { phase: "aggregate" });
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

    // --- セラー名 ---
    const top = stats.slice(0, sellerLimit);
    await setPhase(job.id, { phase: "names", i: 0, n: top.length });
    const profiles = await scraper.resolveSellerNames(
      top.map((s) => s.seller_external_id),
      {
        onProgress: (done, total, name) => {
          void setPhase(job.id, { phase: "names", i: done, n: total, label: name });
        },
      }
    );
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

    // --- 保存 ---
    await setPhase(job.id, { phase: "save" });
    const keep = new Set(top.map((s) => s.seller_external_id));
    const searchId = await createSearch(keyword, aruaru);
    const sellerIds = await upsertSellers(profiles);
    const saved = await saveListings(
      listings.filter((l) => keep.has(l.seller_external_id)),
      profiles,
      log
    );
    await saveSellerResults(searchId, top, sellerIds, log);

    await finishJob(job.id, {
      status: "done",
      result: {
        search_id: searchId,
        listings: listings.length,
        saved: saved.inserted,
        sellers_found: stats.length,
        sellers_saved: top.length,
      },
      resultHref: `/?search=${searchId}`,
    });
    log(`完了しました(searches.id=${searchId})`);
  } finally {
    await scraper.close();
  }
}

// ---------------------------------------------------------------- 実行ループ
async function handle(job: Job) {
  stamp(`ジョブ #${job.seq ?? job.id} [${job.kind}] を開始: ${job.label ?? ""}`);
  try {
    if (job.kind === "search") {
      await runSearch(job);
    } else {
      // 3-2 / 3-3 は既存のCLI(scrape:seller / scrape:sourcing)を使う。
      // ワーカー経由での実行は順次このファイルに寄せていく。
      throw new Error(`このワーカーはまだ ${job.kind} に対応していません`);
    }
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 800);
    stamp(`  失敗: ${msg}`);
    await finishJob(job.id, { status: "error", error: msg }).catch(() => {});
    if (e instanceof BlockedError) {
      stamp(`  ブロックされたため ${Math.round(COOLDOWN_MS / 60000)}分 待機します`);
      await sleep(COOLDOWN_MS);
    }
  }
}

async function main() {
  stamp(`ワーカーを開始しました (id=${WORKER_ID}, ページ間隔=${PAGE_INTERVAL_MS}ms)`);
  stamp("Ctrl+C で停止します。");

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopping) process.exit(1);
      stopping = true;
      stamp("停止します(実行中のジョブが終わるまで待ちます)…");
    });
  }

  let idleLogged = false;
  while (!stopping) {
    let job: Job | null = null;
    try {
      job = await claimJob(WORKER_ID);
    } catch (e) {
      stamp(`DBに接続できません: ${String(e).slice(0, 200)}`);
      await sleep(15000);
      continue;
    }

    if (!job) {
      if (!idleLogged) {
        stamp("待機中(ジョブなし)");
        idleLogged = true;
      }
      await sleep(idleWaitMs);
      // 何も無い状態が続くほど間隔を広げる(最大1分)
      idleWaitMs = Math.min(Math.round(idleWaitMs * 1.5), IDLE_MAX_MS);
      continue;
    }
    idleLogged = false;
    idleWaitMs = IDLE_MIN_MS; // ジョブが来たら最短に戻す
    await handle(job);
  }
  stamp("停止しました。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
