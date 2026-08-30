/**
 * engine/rank_sellers.py のTypeScript移植。
 *
 * セラーリサーチ(1): 検索結果(listings生データ)から、セラーごとの集計値を作り
 * seller_research_results に書き込む。
 *
 * 前提: scraper側で「キーワードのSOLD検索結果」をlistingsテーブルに投入済みであること
 * (listings.seller_id はメルカリ上のセラーとして事前にsellersへ登録されている前提)。
 */
import { getSupabase, must } from "../supabase";
import { mean, turnoverDays } from "./util";

export async function run(
  searchId: number,
  keyword: string,
  sellerIds: number[],
  log: (s: string) => void = console.log
): Promise<void> {
  const sb = getSupabase();
  let inserted = 0;

  for (const sellerId of sellerIds) {
    const res = await sb
      .from("listings")
      .select("price, status, listed_at, sold_at")
      .eq("seller_id", sellerId)
      .order("id", { ascending: true });
    const rows = (must(res) ?? []) as Array<{
      price: number;
      status: string;
      listed_at: string | null;
      sold_at: string | null;
    }>;

    const sold = rows.filter((r) => r.status === "sold");
    if (!sold.length) continue;

    const totalSold = sold.length;
    const avgPrice = sold.reduce((s, r) => s + r.price, 0) / totalSold;
    const turnovers = sold
      .map((r) => turnoverDays(r.sold_at, r.listed_at))
      .filter((v): v is number => v !== null);
    const avgTurnover = mean(turnovers);

    // 新品率: listingsに condition カラムを持たせていない簡易版のため
    // 元コードでもプレースホルダとして null 固定(実装時にconditionカラム追加推奨)
    const newItemRate: number | null = null;

    // 元: INSERT ... ON CONFLICT(search_id, seller_id, matched_keyword) DO UPDATE SET
    //       total_sold, avg_price, turnover_days のみ更新(new_item_rateは触らない)
    const existing = await sb
      .from("seller_research_results")
      .select("id")
      .eq("search_id", searchId)
      .eq("seller_id", sellerId)
      .eq("matched_keyword", keyword)
      .maybeSingle();
    const found = must(existing) as { id: number } | null;

    if (found) {
      must(
        await sb
          .from("seller_research_results")
          .update({ total_sold: totalSold, avg_price: avgPrice, turnover_days: avgTurnover })
          .eq("id", found.id)
          .select("id")
      );
    } else {
      must(
        await sb
          .from("seller_research_results")
          .insert({
            search_id: searchId,
            seller_id: sellerId,
            total_sold: totalSold,
            avg_price: avgPrice,
            turnover_days: avgTurnover,
            new_item_rate: newItemRate,
            matched_keyword: keyword,
          })
          .select("id")
      );
    }
    inserted += 1;
  }

  log(`セラー集計: ${inserted}件登録 (search_id=${searchId}, keyword=${keyword})`);
}
