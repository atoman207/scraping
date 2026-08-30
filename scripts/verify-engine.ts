/**
 * 移植したロジックがPython版と同じ結果を出すかを、DBに接続せずに検証する。
 *   npm run test:engine
 *
 * 検証内容:
 *   1. difflib.SequenceMatcher の移植が、Python公式ドキュメントの例と同じ値を返すか
 *   2. cluster_seller_listings.py のクラスタリングが、サンプルCSVで
 *      「ポーチ3件を1グループ(鉄板候補)、スマホスタンドを別グループ」にするか
 *   3. profit_calc.py / lib/db.ts の計算式が、README記載の例
 *      (仕入22元・発注50個)と一致するか
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { SequenceMatcher } from "../lib/engine/difflib";
import { clusterTitles, summarizeGroup, ClusterItem } from "../lib/engine/cluster";
import { turnoverDays } from "../lib/engine/util";
import { breakevenUnitCostCny, monthlyProfit, profitPerUnit, Settings } from "../lib/db";
import { parseCsv } from "../lib/engine/csv";

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  OK   ${name}: ${a}`);
  } else {
    failed++;
    console.log(`  NG   ${name}: expected ${e}, got ${a}`);
  }
}

console.log("1. difflib.SequenceMatcher の移植");
{
  // Python公式ドキュメントの例: SequenceMatcher(None,"abxcd","abcd").get_matching_blocks()
  //   -> [Match(a=0,b=0,size=2), Match(a=3,b=2,size=2), Match(a=5,b=4,size=0)]
  const sm = new SequenceMatcher("abxcd", "abcd");
  check(
    'get_matching_blocks("abxcd","abcd")',
    sm.getMatchingBlocks().map((m) => [m.a, m.b, m.size]),
    [
      [0, 0, 2],
      [3, 2, 2],
      [5, 4, 0],
    ]
  );
  check('ratio("abxcd","abcd")', sm.ratio(), 8 / 9);
  check('ratio("abcd","bcde")', new SequenceMatcher("abcd", "bcde").ratio(), 0.75);
  check('ratio("abcd","abcd")', new SequenceMatcher("abcd", "abcd").ratio(), 1.0);
  check('ratio("","")', new SequenceMatcher("", "").ratio(), 1.0);
}

console.log("2. タイトルクラスタリング(サンプルCSV)");
const csvPath = path.join(__dirname, "..", "data", "listings_sample.csv");
const rows = parseCsv(readFileSync(csvPath, "utf8"));
const items: ClusterItem[] = rows.map((r, i) => ({
  id: i + 1,
  title: r["title"],
  price: Number(r["price"]),
  status: r["status"],
  image_url: r["image_url"] || null,
  shipping_cost: r["shipping_cost"] ? Number(r["shipping_cost"]) : null,
  sold_at: r["sold_at"] || null,
  turnover_days: turnoverDays(r["sold_at"] || null, r["listed_at"] || null),
}));
check("読み込んだ出品数", items.length, 4);

const groups = clusterTitles(items).map(summarizeGroup);
check("グループ数", groups.length, 2);
check(
  "鉄板商品候補(is_repeat=1)の数",
  groups.filter((g) => g.is_repeat === 1).length,
  1
);
const pouch = groups.find((g) => g.is_repeat === 1)!;
check("鉄板グループの代表タイトル", pouch.representative_title, "ポーチ 刺繍 花柄 小物入れ C");
check("鉄板グループの出品数", pouch.listing_count, 3);
check("鉄板グループのSOLD数", pouch.sold_count, 3);
check("鉄板グループの平均価格", Math.round(pouch.avg_price! * 100) / 100, 1976.67);
check("鉄板グループの平均回転日数", pouch.avg_turnover_days, 3);
check("鉄板グループの平均送料", Math.round(pouch.avg_shipping_cost! * 100) / 100, 211.67);

console.log("3. 利益計算(README記載の例: 仕入22元・発注50個)");
{
  const settings: Settings = {
    exchange_rate_jpy_per_cny: 24,
    agent_fee_pct: 5,
    intl_shipping_cny_per_kg: 9,
    box_weight_kg: 21,
    ng_new_item_rate_threshold: 80,
    ng_turnover_days_threshold: 14,
  };
  const sellPrice = pouch.avg_price!; // 1976.666...
  const profit = profitPerUnit(sellPrice, 10, 210, 22, 50, settings);
  const breakeven = breakevenUnitCostCny(sellPrice, 10, 210, 50, settings);
  const monthly = monthlyProfit(profit, pouch.avg_turnover_days);
  check("1個利益(円)", Math.round(profit!), 924);
  check("黒字ライン仕入値(元)", Math.round(breakeven! * 100) / 100, 58.66);
  check("月利益(円)", Math.round(monthly!), 9239);
  check("原価未入力なら計算しない", profitPerUnit(sellPrice, 10, 210, null, 50, settings), null);
  check("回転日数が無ければ月利益なし", monthlyProfit(profit, null), null);
}

console.log("");
if (failed) {
  console.log(`失敗: ${failed}件`);
  process.exit(1);
}
console.log("すべて期待どおりです。");
