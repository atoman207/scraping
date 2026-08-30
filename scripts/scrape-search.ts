/**
 * 発注仕様書 3-1: セラーリサーチ
 * キーワードでメルカリのSOLD商品を検索し、出品者を解決して sellers/listings に投入。
 * そのあと engine/rank_sellers.py 相当の集計まで一気に流す。
 *
 *   npm run scrape:search -- --keyword "スマホスタンド" --pages 3 --resolve 30
 *   npm run scrape:search -- --keyword "ポーチ" --aruaru "刺繍" "花柄" --pages 2
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import { MercariScraper } from "../lib/scraper/mercari";
import { createSearch, findSellerId, saveListings } from "../lib/scraper/persist";
import { BlockedError, type ScrapedSeller } from "../lib/scraper/types";
import { run as rankSellers } from "../lib/engine/rank";

const args = parseArgs(process.argv.slice(2));
const keyword = requireArg(args, "keyword");
const aruaru = args["aruaru"] ?? [];
const pages = Number(argOne(args, "pages") ?? 3);
const resolveSellerLimit = Number(argOne(args, "resolve") ?? 30);
const intervalMs = Number(argOne(args, "interval") ?? 2500);
const headless = argOne(args, "headed") === undefined;

async function main() {
  const log = (m: string) => console.log(m);
  const scraper = new MercariScraper({ minIntervalMs: intervalMs, headless, log });
  await scraper.start();
  try {
    console.log(`\n=== 3-1 セラーリサーチ: "${keyword}"${aruaru.length ? ` + [${aruaru.join(", ")}]` : ""} ===`);
    const listings = await scraper.searchSold(keyword, aruaru, pages, { resolveSellerLimit });
    if (!listings.length) {
      console.log("取得0件のため終了します。");
      return;
    }

    // セラーのプロフィール(評価数など)を補完する
    const profiles = new Map<string, ScrapedSeller>();
    const uniqueSellers = [...new Set(listings.map((l) => l.seller_external_id))];
    console.log(`\nセラープロフィールを取得します(${uniqueSellers.length}人)`);
    for (const sid of uniqueSellers) {
      try {
        const p = await scraper.getSellerProfile(sid);
        if (p) profiles.set(sid, p);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
      }
    }

    console.log("\n--- DBへ投入 ---");
    const searchId = await createSearch(keyword, aruaru);
    const saved = await saveListings(listings, profiles, log);
    console.log(`searches.id = ${searchId}`);

    // 集計(engine/rank_sellers.py 相当)
    const ids: number[] = [];
    for (const sid of uniqueSellers) {
      const id = await findSellerId("mercari", sid);
      if (id) ids.push(id);
    }
    console.log("\n--- セラー集計 ---");
    await rankSellers(searchId, keyword, ids, log);
    console.log(`\n完了。 http://localhost:3000/ を開くと結果が見られます(search_id=${searchId}, セラー${saved.sellers}人)`);
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
