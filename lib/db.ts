/**
 * 元の webapp/lib/db.ts のSupabase版。
 *
 * - 計算式(landedCostJpy / profitPerUnit / breakevenUnitCostCny / monthlyProfit)は
 *   元ファイルから一字一句そのまま。engine/profit_calc.py とも同じ式。
 * - データ取得部分だけ better-sqlite3 の同期SQL -> supabase-js の非同期クエリに置き換え。
 *   SQLの意味(WHERE / ORDER BY / JOIN)は元と同一。
 */
import { getSupabase, must } from "./supabase";

export { getSupabase, getDb, must } from "./supabase";

export type Settings = {
  exchange_rate_jpy_per_cny: number;
  agent_fee_pct: number;
  intl_shipping_cny_per_kg: number;
  box_weight_kg: number;
  ng_new_item_rate_threshold: number;
  ng_turnover_days_threshold: number;
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
