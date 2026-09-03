/**
 * 元の webapp/lib/db.ts のSupabase版。
 *
 * - 計算式(landedCostJpy / profitPerUnit / breakevenUnitCostCny / monthlyProfit)は
 *   元ファイルから一字一句そのまま。engine/profit_calc.py とも同じ式。
 * - データ取得部分だけ better-sqlite3 の同期SQL -> supabase-js の非同期クエリに置き換え。
 *   SQLの意味(WHERE / ORDER BY / JOIN)は元と同一。
 */
import { getSupabase, must } from "./supabase";
import {
  breakEvenItemCny,
  calcCost,
  calcProfit,
  type CostBreakdown,
  type CostSettings,
} from "./engine/cost";

export { getSupabase, getDb, must } from "./supabase";

export type Settings = {
  exchange_rate_jpy_per_cny: number;
  agent_fee_pct: number;
  intl_shipping_cny_per_kg: number;
  box_weight_kg: number;
  ng_new_item_rate_threshold: number;
  ng_turnover_days_threshold: number;
  /** 輸入消費税 %。既定0(計上しない)。migrations/002 で追加 */
  import_tax_pct?: number | null;
};

// 元: SELECT * FROM settings WHERE id = 1
export async function getSettings(): Promise<Settings> {
  const res = await getSupabase().from("settings").select("*").eq("id", 1).single();
  return must(res) as Settings;
}

export function landedCostJpy(unitCostCny: number | null, orderQty: number, s: Settings): number | null {
  if (unitCostCny === null || !orderQty) return null;
  const shippingPerUnitCny = (s.box_weight_kg * s.intl_shipping_cny_per_kg) / orderQty;
  const landedCny = unitCostCny * (1 + s.agent_fee_pct / 100) + shippingPerUnitCny;
  return landedCny * s.exchange_rate_jpy_per_cny;
}

export function profitPerUnit(
  sellPrice: number,
  feeRatePct: number,
  domesticShippingJpy: number,
  unitCostCny: number | null,
  orderQty: number,
  s: Settings
): number | null {
  const cost = landedCostJpy(unitCostCny, orderQty, s);
  if (cost === null) return null;
  const netSales = sellPrice * (1 - feeRatePct / 100) - domesticShippingJpy;
  return netSales - cost;
}

export function breakevenUnitCostCny(
  sellPrice: number,
  feeRatePct: number,
  domesticShippingJpy: number,
  orderQty: number,
  s: Settings
): number | null {
  if (!orderQty) return null;
  const netSalesJpy = sellPrice * (1 - feeRatePct / 100) - domesticShippingJpy;
  const shippingPerUnitCny = (s.box_weight_kg * s.intl_shipping_cny_per_kg) / orderQty;
  const lhs = netSalesJpy / s.exchange_rate_jpy_per_cny - shippingPerUnitCny;
  return lhs / (1 + s.agent_fee_pct / 100);
}

export function monthlyProfit(profitUnit: number | null, turnoverDays: number | null): number | null {
  if (profitUnit === null || !turnoverDays || turnoverDays <= 0) return null;
  const expectedMonthlySales = 30 / turnoverDays;
  return profitUnit * expectedMonthlySales;
}

// --- セラーリサーチ一覧 ---
export type SellerResearchRow = {
  seller_id: number;
  seller_name: string;
  platform: string;
  rating: number | null;
  review_count: number | null;
  profile_url: string | null;
  total_sold: number;
  avg_price: number;
  turnover_days: number | null;
  new_item_rate: number | null;
};

// 元: seller_research_results JOIN sellers WHERE search_id = ? ORDER BY total_sold DESC
//     PostgRESTのリソース埋め込み(!inner)で同じINNER JOINを表現している。
//     ビューを別途作る必要がなく、schema.sqlをそのまま使える。
export async function getSellerResearchResults(searchId: number): Promise<SellerResearchRow[]> {
  const res = await getSupabase()
    .from("seller_research_results")
    .select(
      "total_sold, avg_price, turnover_days, new_item_rate, sellers!inner(id, seller_name, platform, rating, review_count, profile_url)"
    )
    .eq("search_id", searchId)
    .order("total_sold", { ascending: false });
  return flattenSellerResearch(must(res));
}

/** 埋め込み結果 {..., sellers: {...}} を、元のJOIN結果と同じ平坦な1行に直す */
export function flattenSellerResearch(rows: unknown): SellerResearchRow[] {
  return ((rows ?? []) as Record<string, unknown>[]).map((r) => {
    const sRaw = r.sellers;
    const s = (Array.isArray(sRaw) ? sRaw[0] : sRaw) as Record<string, unknown> | undefined;
    return {
      seller_id: Number(s?.id),
      seller_name: String(s?.seller_name ?? ""),
      platform: String(s?.platform ?? ""),
      rating: (s?.rating ?? null) as number | null,
      review_count: (s?.review_count ?? null) as number | null,
      profile_url: (s?.profile_url ?? null) as string | null,
      total_sold: r.total_sold as number,
      avg_price: r.avg_price as number,
      turnover_days: (r.turnover_days ?? null) as number | null,
      new_item_rate: (r.new_item_rate ?? null) as number | null,
    };
  });
}

// --- セラー深掘り: 鉄板商品候補一覧 ---
export type ProductGroupRow = {
  id: number;
  representative_title: string;
  representative_image_url: string | null;
  listing_count: number;
  sold_count: number;
  avg_price: number | null;
  avg_turnover_days: number | null;
  avg_shipping_cost: number | null;
  is_repeat: number;
};

// 元: SELECT * FROM product_groups WHERE seller_id = ? ORDER BY sold_count DESC, listing_count DESC
export async function getProductGroups(sellerId: number): Promise<ProductGroupRow[]> {
  const res = await getSupabase()
    .from("product_groups")
    .select("*")
    .eq("seller_id", sellerId)
    .order("sold_count", { ascending: false })
    .order("listing_count", { ascending: false });
  return (must(res) ?? []) as ProductGroupRow[];
}

// --- 深掘りリスト: 利益計算込み ---
export type DeepdiveRow = {
  deepdive_id: number;
  representative_title: string;
  representative_image_url: string | null;
  sold_count: number;
  mercari_avg_price: number | null;
  avg_turnover_days: number | null;
  unit_cost_cny: number | null;
  order_qty: number;
  fee_rate_pct: number;
  domestic_shipping_jpy: number;
  source_url: string | null;
};

export async function getDeepdiveList(): Promise<
  (DeepdiveRow & {
    profit_per_unit: number | null;
    breakeven_unit_cost_cny: number | null;
    monthly_profit: number | null;
  })[]
> {
  const settings = await getSettings();
  // 元: SELECT * FROM deepdive_view
  // (SQLiteでは登録順=rowid順で返っていたので、Postgresでは明示的に deepdive_id 昇順にする)
  const res = await getSupabase().from("deepdive_view").select("*").order("deepdive_id", { ascending: true });
  const rows = (must(res) ?? []) as DeepdiveRow[];
  return rows.map((r) => {
    const profit =
      r.mercari_avg_price !== null
        ? profitPerUnit(r.mercari_avg_price, r.fee_rate_pct, r.domestic_shipping_jpy, r.unit_cost_cny, r.order_qty, settings)
        : null;
    const breakeven =
      r.mercari_avg_price !== null
        ? breakevenUnitCostCny(r.mercari_avg_price, r.fee_rate_pct, r.domestic_shipping_jpy, r.order_qty, settings)
        : null;
    return {
      ...r,
      profit_per_unit: profit !== null ? Math.round(profit) : null,
      breakeven_unit_cost_cny: breakeven !== null ? Math.round(breakeven * 100) / 100 : null,
      monthly_profit: (() => {
        const mp = monthlyProfit(profit, r.avg_turnover_days);
        return mp !== null ? Math.round(mp) : null;
      })(),
    };
  });
}

// --- 深掘りリスト v2: 拡張した原価モデル(lib/engine/cost.ts)で計算する ---
// 既存の getDeepdiveList() は元のPython版と同じ式のまま残してある(README の約束)。
// 画面はこちらを使う。中国国内送料・関税・梱包費・回転日数の下限・予想月販の手入力に対応。

export type DeepdiveRowV2 = {
  deepdive_id: number;
  product_group_id: number;
  representative_title: string;
  representative_image_url: string | null;
  sold_count: number;
  listing_count: number;
  mercari_avg_price: number | null;
  avg_turnover_days: number | null;
  avg_shipping_cost: number | null;
  // 原価の入力値
  cost_mode: "detail" | "direct" | null;
  cost_direct_jpy: number | null;
  unit_cost_cny: number | null;
  china_domestic_cny: number | null;
  tariff_cat: string | null;
  box_count: number | null;
  order_qty: number;
  // 販売条件
  sell_price_jpy: number | null;
  shipping_jpy: number | null;
  fee_rate_pct: number;
  packaging_jpy: number | null;
  monthly_qty: number | null;
  source_platform: string | null;
  source_url: string | null;
  status: string | null;
  memo: string | null;
  // 共通設定(ビューが付けてくる)
  exchange_rate_jpy_per_cny: number;
  agent_fee_pct: number;
  intl_shipping_cny_per_kg: number;
  box_weight_kg: number;
  import_tax_pct: number | null;
};

export type DeepdiveComputed = DeepdiveRowV2 & {
  cost_jpy: number | null;
  cost_breakdown: CostBreakdown | null;
  profit_per_unit: number | null;
  monthly_qty_used: number | null;
  monthly_qty_auto: number | null;
  monthly_qty_source: "manual" | "rotation" | null;
  monthly_profit: number | null;
  /** 1個利益が0になる原価(円)。この額以下で仕入れれば黒字 */
  breakeven_cost_jpy: number | null;
  /** 同じものを商品単価(元)に直したもの。仕入交渉で使う */
  breakeven_item_cny: number | null;
  /** 計算できなかった理由(画面にそのまま出せる日本語) */
  reason: string | null;
};

function settingsOf(r: DeepdiveRowV2): CostSettings {
  return {
    exchange_rate_jpy_per_cny: r.exchange_rate_jpy_per_cny,
    agent_fee_pct: r.agent_fee_pct,
    intl_shipping_cny_per_kg: r.intl_shipping_cny_per_kg,
    box_weight_kg: r.box_weight_kg,
    import_tax_pct: r.import_tax_pct,
  };
}

/** 1行ぶんの計算。ビューの行をそのまま渡す。 */
export function computeDeepdiveRow(r: DeepdiveRowV2): DeepdiveComputed {
  const s = settingsOf(r);
  const costInput = {
    cost_mode: r.cost_mode ?? "detail",
    cost_direct_jpy: r.cost_direct_jpy,
    item_cny: r.unit_cost_cny,
    domestic_cny: r.china_domestic_cny,
    tariff_cat: r.tariff_cat,
    // 箱入数が未設定なら、従来どおり発注数で按分する(既存データが壊れないように)
    box_count: r.box_count ?? r.order_qty ?? null,
  };
  const cost = calcCost(costInput, s);
  const p = calcProfit(
    costInput,
    {
      sell_price_jpy: r.sell_price_jpy,
      fee_pct: r.fee_rate_pct,
      shipping_jpy: r.shipping_jpy,
      packaging_jpy: r.packaging_jpy,
      rotation_days: r.avg_turnover_days,
      monthly_qty: r.monthly_qty,
    },
    s
  );
  return {
    ...r,
    cost_jpy: cost.jpy,
    cost_breakdown: cost.breakdown,
    profit_per_unit: p.perUnit,
    monthly_qty_used: p.qty,
    monthly_qty_auto: p.autoQty,
    monthly_qty_source: p.qtySource,
    monthly_profit: p.monthly,
    breakeven_cost_jpy: p.breakEvenCostJpy,
    breakeven_item_cny: breakEvenItemCny(p.breakEvenCostJpy, costInput, s),
    reason: p.reason,
  };
}

export async function getDeepdiveListV2(status?: string): Promise<DeepdiveComputed[]> {
  let q = getSupabase().from("deepdive_view").select("*").order("deepdive_id", { ascending: true });
  if (status) q = q.eq("status", status);
  const rows = (must(await q) ?? []) as DeepdiveRowV2[];
  return rows.map(computeDeepdiveRow);
}
