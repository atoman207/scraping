/**
 * 発注仕様書 3-2: セラー深掘り
 * 指定セラーの出品一覧を取得して listings に投入し、実送料を上位N件だけ取得したうえで、
 * engine/cluster_seller_listings.py 相当の鉄板商品抽出まで一気に流す。
 *
 *   npm run scrape:seller -- --seller 223868190 --max 100 --shipping 3
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import { MercariScraper } from "../lib/scraper/mercari";
import { findSellerId, saveListings } from "../lib/scraper/persist";
import { BlockedError, type ScrapedSeller } from "../lib/scraper/types";
import { run as clusterListings } from "../lib/engine/cluster";
import { getSupabase, must } from "../lib/supabase";

const args = parseArgs(process.argv.slice(2));
const sellerExternalId = requireArg(args, "seller");
const maxItems = Number(argOne(args, "max") ?? 100);
// 実送料は商品ページを1件ずつ開くので、既定は上位3件だけ(仕様書の「標準=上位3件」に合わせた)
const shippingTop = Number(argOne(args, "shipping") ?? 3);
const intervalMs = Number(argOne(args, "interval") ?? 2500);
const headless = argOne(args, "headed") === undefined;

async function main() {
  const log = (m: string) => console.log(m);
  const scraper = new MercariScraper({ minIntervalMs: intervalMs, headless, log });
  await scraper.start();
  try {
    console.log(`\n=== 3-2 セラー深掘り: ${sellerExternalId} ===`);
    const profile = await scraper.getSellerProfile(sellerExternalId);
    const listings = await scraper.getSellerListings(sellerExternalId, maxItems);
    if (!listings.length) {
      console.log("出品が取得できませんでした。セラーIDを確認してください。");
      return;
    }

    // 実送料: SOLDのうち上位N件だけ商品ページを開いて取得する
    const soldTargets = listings.filter((l) => l.status === "sold").slice(0, shippingTop);
    if (soldTargets.length) {
      console.log(`\n実送料を取得します(SOLD上位${soldTargets.length}件のみ)`);
      for (const l of soldTargets) {
        try {
          const cost = await scraper.getRealShippingCost(l.listing_url!);
          if (cost !== null) {
            l.shipping_cost = cost;
            console.log(`  ${l.external_id}: ¥${cost}`);
          }
        } catch (e) {
          if (e instanceof BlockedError) throw e;
          console.log(`  ${l.external_id}: 取得失敗 (${String(e).slice(0, 70)})`);
        }
      }
    }

    console.log("\n--- DBへ投入 ---");
    const profiles = new Map<string, ScrapedSeller>();
    if (profile) profiles.set(sellerExternalId, profile);
    await saveListings(listings, profiles, log);

    // 既存行の送料が空なら埋める(saveListingsは重複を無視するため個別に更新)
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
      console.log("seller_id を解決できませんでした。");
      return;
    }
    console.log("\n--- 鉄板商品の抽出 ---");
    await clusterListings(sellerId, log);
    console.log(`\n完了。 http://localhost:3000/seller-deepdive?seller_id=${sellerId} を開いてください。`);
  } catch (e) {
    if (e instanceof BlockedError) {
      console.error(`\n[中断] ${e.message}\n  URL: ${e.url}`);
      console.error("  --interval を大きく(例: 6000)して時間をおいて再実行してください。");
      process.exitCode = 1;
    } else throw e;
  } finally {
    await scraper.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
