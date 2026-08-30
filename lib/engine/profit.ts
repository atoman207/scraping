/**
 * engine/profit_calc.py のTypeScript移植。
 *
 * 深掘りリスト(3): 仕入単価(元)から着地原価(円)を計算し、
 * 黒字ライン仕入値・1個利益・月利益を算出してCSVに出力する。
 *
 * 計算式(Seller Scopeの設定項目に準拠):
 *   landed_cost_cny = 仕入単価(元) x (1 + 代行手数料%)
 *                     + 箱重量kg x 国際送料(元/kg) / 発注数
 *   landed_cost_jpy = landed_cost_cny x 為替レート(円/元)
 *   1個利益(円) = 売価 x (1 - 販売手数料%) - 国内送料 - landed_cost_jpy
 *   月利益(円)  = 1個利益 x (30 / 回転日数)
 *
 * 式そのものは lib/db.ts (= 元 webapp/lib/db.ts) の関数を再利用しているので、
 * 画面表示とCLI出力で必ず同じ結果になる。
 */
import { writeFileSync } from "node:fs";
import { breakevenUnitCostCny, getSettings, monthlyProfit, profitPerUnit } from "../db";
import { getSupabase, must } from "../supabase";

type ReportRow = {
  deepdive_id: number;
  title: string;
  avg_sold_price: number | null;
  unit_cost_cny: number | null;
  profit_per_unit_jpy: number | null;
  breakeven_unit_cost_cny: number | null;
  monthly_profit_jpy: number | null;
  is_profitable: boolean;
};

export async function collect(): Promise<ReportRow[]> {
  const settings = await getSettings();

  // 元: deepdive_items JOIN product_groups (= deepdive_view と同じ内容)
  const res = await getSupabase().from("deepdive_view").select("*").order("deepdive_id", { ascending: true });
  const rows = (must(res) ?? []) as Array<{
    deepdive_id: number;
    representative_title: string;
    mercari_avg_price: number | null;
    avg_turnover_days: number | null;
    unit_cost_cny: number | null;
    order_qty: number;
    fee_rate_pct: number;
    domestic_shipping_jpy: number;
  }>;

  return rows.map((r) => {
    const sell = r.mercari_avg_price;
    const profit =
      sell !== null
        ? profitPerUnit(sell, r.fee_rate_pct, r.domestic_shipping_jpy, r.unit_cost_cny, r.order_qty, settings)
        : null;
    const breakeven =
      sell !== null ? breakevenUnitCostCny(sell, r.fee_rate_pct, r.domestic_shipping_jpy, r.order_qty, settings) : null;
    const mProfit = monthlyProfit(profit, r.avg_turnover_days);
    return {
      deepdive_id: r.deepdive_id,
      title: r.representative_title,
      avg_sold_price: sell ? Math.round(sell) : null,
      unit_cost_cny: r.unit_cost_cny,
      profit_per_unit_jpy: profit !== null ? Math.round(profit) : null,
      breakeven_unit_cost_cny: breakeven !== null ? Math.round(breakeven * 100) / 100 : null,
      monthly_profit_jpy: mProfit !== null ? Math.round(mProfit) : null,
      is_profitable: (profit ?? 0) > 0,
    };
  });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "True" : "False") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 元の run(db_path, out_path) 相当 */
export async function run(outPath: string, log: (s: string) => void = console.log): Promise<void> {
  const results = await collect();

  let body = "";
  if (results.length) {
    const headers = Object.keys(results[0]);
    body += headers.join(",") + "\r\n";
    for (const r of results) {
      body += headers.map((h) => csvCell((r as Record<string, unknown>)[h])).join(",") + "\r\n";
    }
  }
  // Pythonの encoding="utf-8-sig" と同じくBOM付きUTF-8(Excelで文字化けしない)
  writeFileSync(outPath, "﻿" + body, { encoding: "utf8" });
  log(`出力: ${outPath} (${results.length}件)`);
}
