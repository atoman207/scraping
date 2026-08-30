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
import { appendLog, createJob, finishJob, getJob } from "../../../lib/jobs";
import { BlockedError, type ScrapedSeller } from "../../../lib/scraper/types";
import { checkScraperEnvironment } from "../../../lib/scraper/environment";

export const dynamic = "force-dynamic";
// Vercelの上限を超えるとデプロイが失敗する(Hobby=60秒 / Pro=300秒)。
// スクレイピング自体はレスポンスを待たせずバックグラウンドで走るので、
// このハンドラ自体は数秒で返れば足りる。
export const maxDuration = 60;

export async function GET(req: NextRequest) {
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
  const env = checkScraperEnvironment();
  if (!env.available) {
    return NextResponse.json({ error: `${env.reason} ${env.hint ?? ""}`.trim() }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = String(body.kind ?? "");

  if (kind === "search") {
    const keyword = String(body.keyword ?? "").trim();
    if (!keyword) return NextResponse.json({ error: "キーワードを入力してください" }, { status: 400 });
    const aruaru = String(body.aruaru ?? "")
      .split(/[,、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const pages = clamp(Number(body.pages ?? 2), 1, 10);
    const resolve = clamp(Number(body.resolve ?? 20), 1, 120);
    const job = createJob("search", `「${keyword}」のSOLD検索`);
    void runSearch(job.id, keyword, aruaru, pages, resolve);
    return NextResponse.json({ jobId: job.id });
  }

  if (kind === "seller") {
    const sellerExternalId = String(body.seller_external_id ?? "").trim();
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
    const job = createJob("sourcing", `仕入れ候補の検索 (#${groupId})`);
    void runSourcing(job.id, groupId, Boolean(body.apply));
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

async function runSearch(jobId: string, keyword: string, aruaru: string[], pages: number, resolve: number) {
  const log = (m: string) => appendLog(jobId, m);
  const { MercariScraper } = await import("../../../lib/scraper/mercari");
  const { createSearch, findSellerId, saveListings } = await import("../../../lib/scraper/persist");
  const { run: rankSellers } = await import("../../../lib/engine/rank");
  const scraper = new MercariScraper({ minIntervalMs: 2500, log });
  try {
    await scraper.start();
    log(`検索を開始します: "${keyword}"${aruaru.length ? ` + [${aruaru.join(", ")}]` : ""}`);
    const listings = await scraper.searchSold(keyword, aruaru, pages, { resolveSellerLimit: resolve });
    if (!listings.length) {
      log("該当する出品を取得できませんでした。");
      finishJob(jobId, { status: "done" });
      return;
    }

    const profiles = new Map<string, ScrapedSeller>();
    const uniqueSellers = [...new Set(listings.map((l) => l.seller_external_id))];
    log(`セラープロフィールを取得します(${uniqueSellers.length}人)`);
    for (const sid of uniqueSellers) {
      try {
        const p = await scraper.getSellerProfile(sid);
        if (p) profiles.set(sid, p);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
      }
    }

    const searchId = await createSearch(keyword, aruaru);
    await saveListings(listings, profiles, log);

    const ids: number[] = [];
    for (const sid of uniqueSellers) {
      const id = await findSellerId("mercari", sid);
      if (id) ids.push(id);
    }
    await rankSellers(searchId, keyword, ids, log);
    log("完了しました。");
    finishJob(jobId, { status: "done", resultHref: "/" });
  } catch (e) {
    fail(jobId, e);
  } finally {
    await scraper.close();
  }
}

async function runSeller(jobId: string, sellerExternalId: string, max: number, shippingTop: number) {
  const log = (m: string) => appendLog(jobId, m);
  const { MercariScraper } = await import("../../../lib/scraper/mercari");
  const { findSellerId, saveListings } = await import("../../../lib/scraper/persist");
  const { run: clusterListings } = await import("../../../lib/engine/cluster");
  const { getSupabase, must } = await import("../../../lib/supabase");
  const scraper = new MercariScraper({ minIntervalMs: 2500, log });
  try {
    await scraper.start();
    const profile = await scraper.getSellerProfile(sellerExternalId);
    const listings = await scraper.getSellerListings(sellerExternalId, max);
    if (!listings.length) {
      log("出品を取得できませんでした。セラーIDを確認してください。");
      finishJob(jobId, { status: "done" });
      return;
    }

    const soldTargets = listings.filter((l) => l.status === "sold").slice(0, shippingTop);
    if (soldTargets.length) {
      log(`実送料を取得します(SOLD上位${soldTargets.length}件のみ)`);
      for (const l of soldTargets) {
        try {
          const cost = await scraper.getRealShippingCost(l.listing_url!);
          if (cost !== null) {
            l.shipping_cost = cost;
            log(`  ${l.external_id}: ¥${cost}`);
          }
        } catch (e) {
          if (e instanceof BlockedError) throw e;
        }
      }
    }

    const profiles = new Map<string, ScrapedSeller>();
    if (profile) profiles.set(sellerExternalId, profile);
    await saveListings(listings, profiles, log);

    const sb = getSupabase();
    for (const l of soldTargets) {
      if (l.shipping_cost === null || l.shipping_cost === undefined) continue;
      must(
        await sb
          .from("listings")
          .update({ shipping_cost: l.shipping_cost, shipping_method: l.shipping_method })
          .eq("platform", l.platform)
          .eq("external_id", l.external_id)
          .select("id")
      );
    }

    const sellerId = await findSellerId("mercari", sellerExternalId);
    if (!sellerId) {
      log("seller_id を解決できませんでした。");
      finishJob(jobId, { status: "error", error: "seller_id を解決できませんでした" });
      return;
    }
    await clusterListings(sellerId, log);
    log("完了しました。");
    finishJob(jobId, { status: "done", resultHref: `/seller-deepdive?seller_id=${sellerId}` });
  } catch (e) {
    fail(jobId, e);
  } finally {
    await scraper.close();
  }
}

async function runSourcing(jobId: string, groupId: number, apply: boolean) {
  const log = (m: string) => appendLog(jobId, m);
  const { AliExpressSourcing, Alibaba1688Sourcing } = await import("../../../lib/scraper/sourcing");
  const { getSupabase, must } = await import("../../../lib/supabase");
  const { getSettings } = await import("../../../lib/db");
  const sb = getSupabase();
  let ae: InstanceType<typeof AliExpressSourcing> | null = null;
  try {
    const group = must(
      await sb.from("product_groups").select("id, representative_title").eq("id", groupId).single()
    ) as { id: number; representative_title: string };
    const settings = await getSettings();
    log(`対象: ${group.representative_title}`);
    log(`為替: ${settings.exchange_rate_jpy_per_cny} 円/元`);

    ae = new AliExpressSourcing(settings.exchange_rate_jpy_per_cny, { log });
    await ae.start();
    const candidates = await ae.searchCandidates(group.representative_title, 8);
    log("");
    log("--- AliExpress ---");
    candidates.forEach((c, i) => {
      log(
        `${String(i + 1).padStart(2)}. ${c.price_cny !== null ? `${c.price_cny}元` : "価格不明"}  ${c.title.slice(0, 55)}`
      );
      log(`    ${c.url}`);
    });

    log("");
    log("--- 1688(ログインが必要なため検索リンクのみ) ---");
    for (const c of await new Alibaba1688Sourcing().searchCandidates(group.representative_title)) {
      log(`  ${c.title}`);
      log(`    ${c.url}`);
    }

    if (apply) {
      const cheapest = candidates
        .filter((c) => c.price_cny !== null)
        .sort((a, b) => a.price_cny! - b.price_cny!)[0];
      const items = must(
        await sb.from("deepdive_items").select("id").eq("product_group_id", groupId)
      ) as { id: number }[];
      if (cheapest && items.length) {
        for (const it of items) {
          must(
            await sb
              .from("deepdive_items")
              .update({
                unit_cost_cny: cheapest.price_cny,
                source_platform: "aliexpress",
                source_url: cheapest.url,
              })
              .eq("id", it.id)
              .select("id")
          );
        }
        log("");
        log(`最安候補 ${cheapest.price_cny}元 を深掘りリスト${items.length}件に反映しました。`);
      } else {
        log("");
        log("反映できる候補、または深掘りリストの行がありませんでした。");
      }
    }
    finishJob(jobId, { status: "done", resultHref: "/deepdive-list" });
  } catch (e) {
    fail(jobId, e);
  } finally {
    await ae?.close();
  }
}
