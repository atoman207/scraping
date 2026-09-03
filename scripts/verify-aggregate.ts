/**
 * lib/engine/aggregate.ts の検証。
 *   npx tsx scripts/verify-aggregate.ts
 *
 * 実データではなく、境界条件を狙った作り物のデータで確かめる。
 * (実データでの動作確認は npm run scrape:search -- --dry で行う)
 */
import { aggregateBySeller, classifySeller, judgeSeller, median, turnoverOf } from "../lib/engine/aggregate";

let pass = 0;
let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  OK  " : "  NG  "} ${label}\n         got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

console.log("\n=== 回転日数 ===");
eq("出品から3日後に更新 → 3日", turnoverOf("2026-09-01T00:00:00Z", "2026-09-04T00:00:00Z"), 3);
eq("同日 → 0日", turnoverOf("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"), 0);
eq("更新が出品より前(データ不整合) → null", turnoverOf("2026-09-04T00:00:00Z", "2026-09-01T00:00:00Z"), null);
eq("出品日が無い → null", turnoverOf(null, "2026-09-04T00:00:00Z"), null);

console.log("\n=== 中央値(外れ値に強いか) ===");
eq("[1,2,3] → 2", median([1, 2, 3]), 2);
eq("[1,2,3,400] → 2.5 (平均だと101.5)", median([1, 2, 3, 400]), 2.5);
eq("空 → null", median([]), null);

console.log("\n=== セラー分類 ===");
eq("2件 → 小規模/単発", classifySeller(2, 1), "小規模/単発");
eq("5件・1ジャンル → 中堅特化", classifySeller(5, 1), "中堅特化");
eq("12件・1ジャンル → 専門特化(穴場候補)", classifySeller(12, 1), "専門特化(穴場候補)");
eq("12件・5ジャンル → 複数展開", classifySeller(12, 5), "複数展開");

console.log("\n=== 集計: 新品と中古が混ざったセラー ===");
// A: 新品3・中古1 → 新品率75%。中古を除くと売上3件
// B: 中古のみ2件 → 新品率0%。中古を除くと集計対象から消える
const items = [
  { seller_external_id: "A", price: 1000, listed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T00:00:00Z", is_new: true, category_id: "1" },
  { seller_external_id: "A", price: 2000, listed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", is_new: true, category_id: "1" },
  { seller_external_id: "A", price: 3000, listed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-05T00:00:00Z", is_new: true, category_id: "1" },
  { seller_external_id: "A", price: 9000, listed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", is_new: false, category_id: "2" },
  { seller_external_id: "B", price: 500, listed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", is_new: false, category_id: "1" },
  { seller_external_id: "B", price: 700, listed_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", is_new: false, category_id: "1" },
];

const excl = aggregateBySeller(items, { includeUsed: false });
eq("中古を除くと、中古のみのセラーBは消える", excl.map((s) => s.seller_external_id), ["A"]);
const a = excl[0];
eq("Aの売上件数は新品の3件", a.total_sold, 3);
eq("Aの平均価格は新品のみ (1000+2000+3000)/3", a.avg_price, 2000);
eq("Aの新品率は中古も分母に入れて75%", a.new_item_rate, 75);
eq("Aの回転日数は中央値2日", a.turnover_days, 2);
eq("Aのジャンル数は新品のみで1", a.genre_count, 1);

const incl = aggregateBySeller(items, { includeUsed: true });
eq("中古も含めるとセラーBも出る", incl.map((s) => s.seller_external_id).sort(), ["A", "B"]);
eq("Aの売上件数は4件になる", incl.find((s) => s.seller_external_id === "A")!.total_sold, 4);
eq("Bの新品率は0%", incl.find((s) => s.seller_external_id === "B")!.new_item_rate, 0);

console.log("\n※ ここが要点: 検索の段階で新品に絞ってしまうと新品率が必ず100%になり、");
console.log("   「中古メインのセラーかどうか」を判定できなくなる。だから検索では絞らず、集計側で分ける。");

console.log("\n=== NG判定 ===");
eq(
  "新品率50%は基準80%未満なのでNG",
  judgeSeller({ new_item_rate: 50, turnover_days: 3, seller_type: "中堅特化" }, 80, 14).ng,
  true
);
eq(
  "回転20日は基準14日超なのでNG",
  judgeSeller({ new_item_rate: 100, turnover_days: 20, seller_type: "中堅特化" }, 80, 14).ng,
  true
);
eq(
  "どちらも基準内ならNGでない",
  judgeSeller({ new_item_rate: 100, turnover_days: 3, seller_type: "中堅特化" }, 80, 14).ng,
  false
);
eq(
  "穴場候補は hot になる",
  judgeSeller({ new_item_rate: 100, turnover_days: 3, seller_type: "専門特化(穴場候補)" }, 80, 14).hot,
  true
);
eq(
  "データが無い項目ではNGにしない(不明を悪と決めつけない)",
  judgeSeller({ new_item_rate: null, turnover_days: null, seller_type: "中堅特化" }, 80, 14).ng,
  false
);

console.log(`\n===== 結果: ${pass}件OK / ${fail}件NG =====\n`);
process.exit(fail ? 1 : 0);
