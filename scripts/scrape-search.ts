/**
 * 発注仕様書 3-1: セラーリサーチ
 *
 * キーワードでメルカリのSOLD商品を新しい順に指定ページ数ぶん取得し、
 * セラー単位に集計して sellers / listings / seller_research_results に投入する。
 *
 *   npm run scrape:search -- --keyword "スマホ スタンド" --pages 10
 *   npm run scrape:search -- --keyword "ポーチ" --aruaru "インポート" "海外" --pages 5
 *   npm run scrape:search -- --keyword "トレカ" --pages 3 --used        # 中古も含む(せどり用)
 *   npm run scrape:search -- --keyword "工具" --pages 3 --sellers 50    # 名前を引くセラー数
 *   npm run scrape:search -- --keyword "LED" --pages 2 --dry            # DBに書かずに結果だけ見る
 *
 * 流れ:
 *   1. 検索ページを1ページずつ開き、ページ自身が受け取った検索結果を読む
 *      (出品者IDが全件に入っているので、追加のアクセス無しで全件のセラーが分かる)
 *   2. メモリ上でセラー単位に集計(件数・平均価格・回転日数・新品率・ジャンル数)
 *   3. 売れた件数の多い上位N人だけ、プロフィールを開いて名前と評価数を取る
 *   4. DBへ投入
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import { MercariScraper } from "../lib/scraper/mercari";
import { createSearch, saveListings, saveSellerResults, upsertSellers } from "../lib/scraper/persist";
import { BlockedError, type ScrapedSeller } from "../lib/scraper/types";
import { aggregateBySeller } from "../lib/engine/aggregate";

const args = parseArgs(process.argv.slice(2));
const keyword = requireArg(args, "keyword");
const aruaru = args["aruaru"] ?? [];
const pages = Number(argOne(args, "pages") ?? 10);
/** 名前と評価数を引くセラーの上限。多すぎると1人ずつ開くので時間がかかる */
const sellerLimit = Number(argOne(args, "sellers") ?? 60);
const intervalMs = Number(argOne(args, "interval") ?? 5000);
const includeUsed = args["used"] !== undefined;
const headless = argOne(args, "headed") === undefined;
const dryRun = args["dry"] !== undefined;

async function main() {
  const log = (m: string) => console.log(m);
  const scraper = new MercariScraper({ minIntervalMs: intervalMs, headless, log });
  await scraper.start();
  const startedAt = Date.now();

  try {
    console.log(
      `\n=== 3-1 セラーリサーチ ===\n` +
        `  キーワード : ${keyword}\n` +
        `  あるあるワード: ${aruaru.length ? aruaru.join(" / ") : "(なし)"}\n` +
        `  ページ数   : ${pages}\n` +
        `  商品状態   : ${includeUsed ? "中古も含む" : "中古は売上件数から除外(新品率は全件で計算)"}\n` +
        `  アクセス間隔: ${intervalMs}ms\n`
    );

    // ---- 1. 検索 ----
    const listings = await scraper.searchSold(keyword, aruaru, pages, {
      includeUsed,
      onPage: ({ query, page, pages: n, got, total }) =>
        console.log(`    [${query}] ${page}/${n}ページ 取得${got}件 累計${total}件`),
    });
    if (!listings.length) {
      console.log("売れた出品が0件でした。キーワードを見直してください。");
      return;
    }

    // ---- 2. 集計 ----
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
    console.log(`\n--- 集計 ---`);
    console.log(`  出品 ${listings.length}件 / セラー ${stats.length}人`);
    const byType = stats.reduce<Record<string, number>>((acc, s) => {
      acc[s.seller_type] = (acc[s.seller_type] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`  内訳: ${Object.entries(byType).map(([k, v]) => `${k} ${v}人`).join(" / ")}`);

    // ---- 3. 上位セラーの名前を解決 ----
    const top = stats.slice(0, sellerLimit);
    console.log(`\n--- セラー名の取得(上位${top.length}人) ---`);
    const profiles = await scraper.resolveSellerNames(
      top.map((s) => s.seller_external_id),
      {
        onProgress: (done, total, name) => {
          if (done % 10 === 0 || done === total) console.log(`    ${done}/${total}人 … ${name}`);
        },
      }
    );

    // 名前が取れなかったセラーもIDだけで登録できるよう、埋めておく
    for (const s of top) {
      if (profiles.has(s.seller_external_id)) continue;
      profiles.set(s.seller_external_id, {
        platform: "mercari",
        seller_external_id: s.seller_external_id,
        seller_name: s.seller_external_id,
        rating: null,
        review_count: null,
        profile_url: scraper.profileUrl(s.seller_external_id),
      } satisfies ScrapedSeller);
    }

    console.log(`\n--- 結果(上位20人) ---`);
    console.log(
      "  " +
        ["セラー名", "SOLD", "平均価格", "回転日数", "新品率", "分類"].join("\t")
    );
    for (const s of top.slice(0, 20)) {
      const p = profiles.get(s.seller_external_id);
      console.log(
        "  " +
          [
            (p?.seller_name ?? s.seller_external_id).slice(0, 18),
            s.total_sold,
            `¥${s.avg_price.toLocaleString()}`,
            s.turnover_days === null ? "-" : `${s.turnover_days}日`,
            s.new_item_rate === null ? "-" : `${s.new_item_rate}%`,
            s.seller_type,
          ].join("\t")
      );
    }

    if (dryRun) {
      console.log("\n--dry のためDBには書き込みませんでした。");
      return;
    }

    // ---- 4. DBへ投入 ----
    console.log("\n--- DBへ投入 ---");
    const keep = new Set(top.map((s) => s.seller_external_id));
    const kept = listings.filter((l) => keep.has(l.seller_external_id));
    const searchId = await createSearch(keyword, aruaru);
    const sellerIds = await upsertSellers(profiles);
    await saveListings(kept, profiles, log);
    await saveSellerResults(searchId, top, sellerIds, log);
    console.log(`searches.id = ${searchId}`);
    console.log(`\n画面で確認: /  (セラーリサーチ)`);
  } catch (e) {
    if (e instanceof BlockedError) {
      console.error(
        `\nメルカリ側にアクセスを拒否されました。\n` +
          `  ${e.message}\n` +
          `  時間をおいてから、--interval を大きくして(例: 8000)再実行してください。`
      );
      process.exitCode = 2;
      return;
    }
    throw e;
  } finally {
    await scraper.close();
    console.log(`\n所要 ${Math.round((Date.now() - startedAt) / 1000)}秒`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
