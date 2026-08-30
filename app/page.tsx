import Link from "next/link";
import { getSupabase, must, flattenSellerResearch, SellerResearchRow } from "../lib/db";
import ScrapeRunner from "./ScrapeRunner";
import { IconAlert, IconArrowRight, IconInbox, IconStar, IconUsers } from "./icons";

export const dynamic = "force-dynamic"; // DBの最新状態を毎回読むため静的化しない

type Search = { id: number; keywords: string; aruaru_words: string | null; created_at: string | null };

async function getLatestSearchResults(): Promise<{ search: Search | null; rows: SellerResearchRow[] }> {
  const db = getSupabase();
  // 元: SELECT id FROM searches ORDER BY id DESC LIMIT 1
  const latestRes = await db
    .from("searches")
    .select("id, keywords, aruaru_words, created_at")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const search = must(latestRes) as Search | null;
  if (!search) return { search: null, rows: [] };
  // 元: seller_research_results JOIN sellers WHERE search_id = ? ORDER BY total_sold DESC
  const rowsRes = await db
    .from("seller_research_results")
    .select(
      "total_sold, avg_price, turnover_days, new_item_rate, sellers!inner(id, seller_name, platform, rating, review_count, profile_url)"
    )
    .eq("search_id", search.id)
    .order("total_sold", { ascending: false });
  return { search, rows: flattenSellerResearch(must(rowsRes)) };
}

export default async function SellerResearchPage() {
  let search: Search | null = null;
  let rows: SellerResearchRow[] = [];
  let error: string | null = null;
  try {
    const res = await getLatestSearchResults();
    search = res.search;
    rows = res.rows;
  } catch (e) {
    error = String(e);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">
          <IconUsers size={20} />
          セラーリサーチ
        </h1>
        <p className="page-desc">
          キーワードでメルカリのSOLD商品を検索し、同じセラーが繰り返し出てくる=有力セラーを一覧化します。
          気になるセラーの「深掘りへ」から、そのセラーの鉄板商品を調べられます。
        </p>
      </div>

      <ScrapeRunner
        kind="search"
        withSearchForm
        buttonLabel="メルカリを検索"
        title="メルカリのSOLD検索を実行"
        description="検索結果から出品者を特定してDBに保存し、セラーごとの集計まで自動で行います。ページ数と件数を増やすほど時間がかかります(1ページ約120件、出品者の特定は1件あたり約3秒)。"
      />

      {error && (
        <div className="note note-error">
          <IconAlert size={15} />
          <span>データ読み込みエラー: {error}</span>
        </div>
      )}

      {search && (
        <div className="meta" style={{ marginBottom: 12 }}>
          <span className="badge badge-muted">直近の検索</span>
          <strong style={{ color: "var(--text)" }}>{search.keywords}</strong>
          {search.aruaru_words && (
            <>
              <span className="sep">・</span>
              <span>あるあるワード: {search.aruaru_words}</span>
            </>
          )}
          <span className="sep">・</span>
          <span>{rows.length}人のセラー</span>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>セラー名</th>
                <th>評価</th>
                <th>総SOLD</th>
                <th>平均価格</th>
                <th>回転日数</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.seller_id}>
                  <td style={{ fontWeight: 600 }}>{r.seller_name}</td>
                  <td className="num" style={{ color: "var(--text-muted)" }}>
                    {r.review_count !== null ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <IconStar size={12} style={{ color: "#f5a623" }} />
                        {r.review_count.toLocaleString()}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="num">
                    <span className="badge badge-brand">{r.total_sold}件</span>
                  </td>
                  <td className="num">¥{Math.round(r.avg_price).toLocaleString()}</td>
                  <td className="num" style={{ color: "var(--text-muted)" }}>
                    {r.turnover_days ? `${r.turnover_days.toFixed(1)}日` : "-"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Link href={`/seller-deepdive?seller_id=${r.seller_id}`} className="link">
                      深掘りへ
                      <IconArrowRight size={13} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !error && (
          <div className="empty">
            <IconInbox size={30} />
            <div>まだ検索結果がありません。</div>
            <div style={{ fontSize: 12.5, marginTop: 4 }}>
              上のフォームにキーワードを入れて「メルカリを検索」を押してください。
            </div>
          </div>
        )
      )}
    </div>
  );
}
