/**
 * 発注仕様書 3-2: セラー深掘り
 *
 * 指定セラーの出品一覧を新しい順に最大100件取得して listings に投入し、
 * 実送料を上位N件だけ取得したうえで、鉄板商品(繰り返し出品)の抽出まで一気に流す。
 *
 *   npm run scrape:seller -- --seller 223868190
 *   npm run scrape:seller -- --seller 223868190 --max 100 --shipping 20
 *   npm run scrape:seller -- --seller shops:waKfjvmcR3eg7r4eL3xS8b
 *
 * オプション:
 *   --seller    セラーID。メルカリShopsは "shops:<店舗ID>"。プロフィールURLでも可
 *   --max       取得する出品数の上限(既定100 = 仕様書の上限)
 *   --shipping  実送料を取りに行くSOLD上位件数(既定3。詳細モードは20)
 *   --interval  アクセス間隔ミリ秒(既定2500)。ブロックされたら大きくする
 *   --headed    ブラウザを画面に出す(動作確認用)
 *   --dry-run   DBに書かず、取得結果だけ表示する
 *
 * 処理の本体は lib/scraper/seller-run.ts にある(画面・ワーカーからも同じものを使う)。
 * ここは引数の受け取りと表示だけを担当する。
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_ITEMS,
  DEFAULT_SHIPPING_TOP,
  runSellerDeepdive,
} from "../lib/scraper/seller-run";
import { BlockedError } from "../lib/scraper/types";

const args = parseArgs(process.argv.slice(2));
const maxItems = Number(argOne(args, "max") ?? DEFAULT_MAX_ITEMS);
// 実送料は商品ページを1件ずつ開くので、既定は上位3件だけ(仕様書の「標準=上位3件」に合わせた)
const shippingTop = Number(argOne(args, "shipping") ?? DEFAULT_SHIPPING_TOP);
const intervalMs = Number(argOne(args, "interval") ?? DEFAULT_INTERVAL_MS);
const headless = argOne(args, "headed") === undefined;
const dryRun = args["dry-run"] !== undefined;
const sellerExternalId = requireArg(args, "seller");

async function main() {
  const log = (m: string) => console.log(m);
  try {
    console.log(`\n=== 3-2 セラー深掘り: ${sellerExternalId} ===`);
    const result = await runSellerDeepdive({
      sellerExternalId,
      maxItems,
      shippingTop,
      intervalMs,
      headless,
      dryRun,
      log,
    });

    if (!result.listings) {
      process.exitCode = 1;
      return;
    }

    if (dryRun) {
      console.log("\n--- 取得結果(--dry-run のためDBには書きません) ---");
      for (const l of result.items.slice(0, 20)) {
        const ship =
          l.ship_status === "skip"
            ? ""
            : l.shipping_cost !== null
              ? ` 送料¥${l.shipping_cost}${l.ship_class ? `(${l.ship_class})` : ""}`
              : ` 送料:${l.ship_status}`;
        console.log(
          `  ${l.status === "sold" ? "SOLD" : "販売中"} ¥${l.price.toLocaleString()} ` +
            `${(l.listed_at ?? "").slice(0, 10)} ${l.title.slice(0, 34)}${ship}`
        );
      }
      if (result.items.length > 20) console.log(`  … 他 ${result.items.length - 20}件`);
      return;
    }

    console.log(
      `\nグループ${result.groups}件(うち鉄板商品${result.repeat_groups}件)を保存しました。`
    );
    console.log(
      `完了。 http://localhost:3000${result.result_href} を開いてください。`
    );
  } catch (e) {
    if (e instanceof BlockedError) {
      console.error(`\n[中断] ${e.message}\n  URL: ${e.url}`);
      console.error("  --interval を大きく(例: 6000)して時間をおいて再実行してください。");
      process.exitCode = 1;
    } else throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
