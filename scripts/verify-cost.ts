/**
 * lib/engine/cost.ts の検証。
 *
 * Seller Scope の実データ（sellerscope-out で取得した /api/buylist と /api/research の
 * 実際の値と、画面に表示されていた金額）と突き合わせ、同じ数字が出るかを確認する。
 * 実行: npx tsx scripts/verify-cost.ts
 */
import {
  breakEvenFromSale,
  breakEvenItemCny,
  calcCost,
  calcProfit,
  calcProfitRange,
  monthlyQtyFromRotation,
  type CostSettings,
} from "../lib/engine/cost";

// Seller Scope のアカウント設定（/api/me の settings 実値）
const S: CostSettings = {
  exchange_rate_jpy_per_cny: 23.5,
  agent_fee_pct: 5,
  intl_shipping_cny_per_kg: 9,
  box_weight_kg: 21,
  import_tax_pct: 0, // Seller Scope 互換（彼らは輸入消費税を計上していない）
};

let pass = 0;
let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  OK  " : "  NG  "} ${label}\n         got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
function near(label: string, got: number | null, want: number, tol = 1) {
  const ok = got !== null && Math.abs(got - want) <= tol;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  OK  " : "  NG  "} ${label}\n         got=${got} want=${want}±${tol}`);
}

console.log("\n=== 1. 原価: 仕入リストの実データ（デジタルキッチンスケール）===");
// /api/buylist の実値: item_cny=8.4, domestic_cny=0.5, box_count=300, tariff_cat='other', packaging=20
// 画面表示: 原価 ¥244 ・ 売価 ¥628 ・ 送料 ¥160 ・ 手数料 10% ・ 1個利益 +¥141 ・ 月利益 +¥8,460
const scale = {
  cost_mode: "detail" as const,
  item_cny: 8.4,
  domestic_cny: 0.5,
  tariff_cat: "other",
  box_count: 300,
};
const scaleCost = calcCost(scale, S);
console.log("  内訳(円):", scaleCost.breakdown);
near("原価 = ¥244（画面表示と一致するか）", scaleCost.jpy, 244);

const scaleProfit = calcProfit(scale, {
  sell_price_jpy: 628,
  fee_pct: 10,
  shipping_jpy: 160,
  packaging_jpy: 20,
  rotation_days: 0.1, // /api/buylist の rotation 実値
}, S);
near("1個利益 = +¥141", scaleProfit.perUnit, 141);
eq("予想月販 = 60個（回転0.1日→下限0.5日で頭打ち）", scaleProfit.qty, 60);
near("月利益 = +¥8,460", scaleProfit.monthly, 8460);
eq("月販の根拠 = rotation", scaleProfit.qtySource, "rotation");

console.log("\n=== 2. 回転日数の下限（Seller Scope に無いと数字が爆発する箇所）===");
eq("回転0.1日 → 60個（30/0.5）", monthlyQtyFromRotation(0.1), 60);
eq("回転0日 → 60個", monthlyQtyFromRotation(0), 60);
eq("回転3.5日 → 8.6個", monthlyQtyFromRotation(3.5), 8.6);
eq("回転データなし → null", monthlyQtyFromRotation(null), null);
console.log("  ※ 下限が無いと 30/0.1 = 300個/月 になり、月利益が5倍に膨らむ");

console.log("\n=== 3. 黒字ライン仕入値（深掘り結果の一覧に出る列）===");
// 深掘り結果の実データ: avg_price=950, ship='ゆうゆうメルカリ便', fee=null(取得できず)
near("売価950・送料160・手数料10% → ¥695", breakEvenFromSale(950, 160), 695);
eq("送料が未取得なら null（画面では『送料待ち』）", breakEvenFromSale(950, null), null);

console.log("\n=== 4. 未入力の扱い ===");
const noItem = calcCost({ cost_mode: "detail", item_cny: null }, S);
eq("仕入単価が未入力 → 原価 null", noItem.jpy, null);
eq("理由が日本語で返る", noItem.reason, "仕入単価が未入力です");

const noShip = calcProfit(scale, { sell_price_jpy: 628, fee_pct: 10, shipping_jpy: null }, S);
eq("送料未取得 → 1個利益 null", noShip.perUnit, null);
eq("理由 = 送料入力待ち", noShip.reason, "送料入力待ち");
eq("原価だけは出せている", noShip.cost, 244);

console.log("\n=== 5. 直接入力モード ===");
const direct = calcCost({ cost_mode: "direct", cost_direct_jpy: 677 }, S);
eq("原価を直接指定 → そのまま", direct.jpy, 677);

console.log("\n=== 6. 仕入先未確定のときの利益の幅（トレーニングラダー 5m）===");
// /api/research の実データ: avg_price=798, shipping=215, rotation=3.5
// 画面表示: 原価 ¥602〜927（目安） / 1個利益 −¥424 〜 −¥99 / 月利益 −¥3,646 〜 −¥851
// AliExpress候補の価格から幅を出す（候補は円建てなので元に直して渡す）
const cand = [669, 663, 900].map((jpy) => jpy / S.exchange_rate_jpy_per_cny);
const range = calcProfitRange(cand, { cost_mode: "detail", tariff_cat: "other", box_count: null }, {
  sell_price_jpy: 798,
  fee_pct: 10,
  shipping_jpy: 215,
  rotation_days: 3.5,
}, S);
console.log("  利益の下限:", range?.lo.perUnit, "／ 上限:", range?.hi.perUnit);
console.log("  月利益の下限:", range?.lo.monthly, "／ 上限:", range?.hi.monthly);
eq("候補があれば幅が出る", range !== null, true);
eq("下限 < 上限（高く仕入れるほど利益が減る）", (range?.lo.perUnit ?? 0) < (range?.hi.perUnit ?? 0), true);
eq("候補が空なら null", calcProfitRange([], scale, { sell_price_jpy: 798 }, S), null);

console.log("\n=== 7. 関税区分 ===");
for (const [cat, want] of [["clothing", 10], ["plastic", 3], ["rubber", 0], ["other", 5], ["unknown", 5]] as const) {
  const c = calcCost({ cost_mode: "detail", item_cny: 100, tariff_cat: cat }, S);
  const tariffJpy = Math.round((100 * want) / 100 * S.exchange_rate_jpy_per_cny);
  near(`${cat} → 関税 ${want}%`, Math.round(c.breakdown!.tariff), tariffJpy);
}

console.log("\n=== 8. 黒字ライン原価を「元」に戻す（仕入交渉用・Seller Scope に無い機能）===");
const be = calcProfit(scale, { sell_price_jpy: 628, fee_pct: 10, shipping_jpy: 160, packaging_jpy: 20 }, S);
const beCny = breakEvenItemCny(be.breakEvenCostJpy, scale, S);
console.log(`  黒字ライン原価 ¥${be.breakEvenCostJpy} → 商品単価 ${beCny}元 まで出せる`);
// 検算: その単価で計算し直すと1個利益がほぼ0になるはず
const check = calcProfit({ ...scale, item_cny: beCny }, {
  sell_price_jpy: 628, fee_pct: 10, shipping_jpy: 160, packaging_jpy: 20,
}, S);
near("その単価で仕入れると1個利益がほぼ0", check.perUnit, 0, 2);

console.log("\n=== 9. 輸入消費税を計上した場合（Seller Scope には無い）===");
const withTax = calcCost(scale, { ...S, import_tax_pct: 10 });
console.log("  内訳(円):", withTax.breakdown);
eq("消費税0%より原価が上がる", (withTax.jpy ?? 0) > (scaleCost.jpy ?? 0), true);
console.log(`  原価 ¥${scaleCost.jpy} → ¥${withTax.jpy}（消費税10%を計上した場合）`);

console.log(`\n===== 結果: ${pass}件OK / ${fail}件NG =====\n`);
process.exit(fail ? 1 : 0);
