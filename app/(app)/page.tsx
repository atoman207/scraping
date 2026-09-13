import Link from "next/link";
import {
  getSettings,
  getSupabase,
  must,
  readSellerResearch,
  SellerResearchRow,
  type Settings,
} from "../../lib/db";
import Avatar from "../Avatar";
import SellerTable, { type SellerSortKeys } from "../SellerTable";
import MigrationNotice from "../MigrationNotice";
import ScrapeRunner from "../ScrapeRunner";
import {
  IconAlert,
  IconArrowRight,
  IconAward,
  IconBox,
  IconClock,
  IconExternal,
  IconFlame,
  IconInbox,
  IconPie,
  IconStar,
  IconTag,
  IconUsers,
} from "../icons";

export const dynamic = "force-dynamic"; // DBの最新状態を毎回読むため静的化しない

type Search = { id: number; keywords: string; aruaru_words: string | null; created_at: string | null };

async function getLatestSearchResults(): Promise<{
  search: Search | null;
  rows: SellerResearchRow[];
  needsMigration: boolean;
}> {
  const db = getSupabase();
  // 元: SELECT id FROM searches ORDER BY id DESC LIMIT 1
  const latestRes = await db
    .from("searches")
    .select("id, keywords, aruaru_words, created_at")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const search = must(latestRes) as Search | null;
  if (!search) return { search: null, rows: [], needsMigration: false };
  // 元: seller_research_results JOIN sellers WHERE search_id = ? ORDER BY total_sold DESC
  const { rows, needsMigration } = await readSellerResearch(search.id);
  return { search, rows, needsMigration };
}

/**
 * セラー分類の見せ方。
 * 「専門特化(穴場候補)」は探している当のものなので、いちばん目立つ色にする。
 */
/**
 * 分類を並べ替えるための格付け。
 *
 * 文字列のまま並べると「小規模」「中堅」「専門」が五十音順になってしまい、
 * 有望さの順にならない。画面のバッジ(sellerTypePill)と同じ判定で数値にする。
 */
function sellerTypeRank(type: string | null): number | null {
  if (!type) return null;
  if (type.includes("穴場")) return 3;
  if (type.includes("特化")) return 2;
  if (type.includes("複数")) return 1;
  return 0;
}

function sellerTypePill(type: string | null): { cls: string; label: string } | null {
  if (!type) return null;
  if (type.includes("穴場")) return { cls: "pill-hot", label: type };
  if (type.includes("特化")) return { cls: "pill-good", label: type };
  if (type.includes("複数")) return { cls: "pill-info", label: type };
  return { cls: "pill-mute", label: type };
}

export default async function SellerResearchPage() {
  let search: Search | null = null;
  let rows: SellerResearchRow[] = [];
  let settings: Settings | null = null;
  let needsMigration = false;
  let error: string | null = null;
  try {
    const res = await getLatestSearchResults();
    search = res.search;
    rows = res.rows;
    needsMigration = res.needsMigration;
  } catch (e) {
    error = String(e);
  }
  // NG判定のしきい値は設定から読む。読めなくても画面は出す(既定値で判定する)
  try {
    settings = await getSettings();
  } catch {
    settings = null;
  }
  const ngNewRate = settings?.ng_new_item_rate_threshold ?? 80;
  const ngTurnover = settings?.ng_turnover_days_threshold ?? 14;

  // 並べ替えに使う値。行と同じ並びで SellerTable へ渡す
  const sortKeys: SellerSortKeys[] = rows.map((r) => ({
    type: sellerTypeRank(r.seller_type),
    rating: r.review_count,
    sold: r.total_sold,
    price: r.avg_price,
    turnover: r.turnover_days,
    newRate: r.new_item_rate,
  }));
  const totalSold = rows.reduce((a, r) => a + r.total_sold, 0);
  const hotCount = rows.filter((r) => r.seller_type?.includes("穴場")).length;
  const okRows = rows.filter(
    (r) =>
      !(r.new_item_rate !== null && r.new_item_rate < ngNewRate) &&
      !(r.turnover_days !== null && r.turnover_days > ngTurnover)
  );

  return (
    <div className="page page-wide">
      <div className="page-head">
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
        description="キーワードは1行に1つ・最大10個。関連語を複数入れると有力セラーが見つかりやすくなります。ページ数と件数を増やすほど時間がかかります(1ページ約120件、出品者の特定は1件あたり約3秒)。"
      />

      {needsMigration && <MigrationNotice what="アバター・セラー分類・新品率" />}

      {error && (
        <div className="note note-error">
          <IconAlert size={15} />
          <span>データ読み込みエラー: {error}</span>
        </div>
      )}

      {rows.length > 0 && (
        <div className="tiles fade-up">
          <div className="tile">
            <div className="tile-label">
              <IconUsers size={12} />
              セラー
            </div>
            <div className="tile-value">{rows.length.toLocaleString()}</div>
            <div className="tile-sub">条件を満たす {okRows.length.toLocaleString()}人</div>
          </div>
          <div className="tile">
            <div className="tile-label">
              <IconBox size={12} />
              総SOLD
            </div>
            <div className="tile-value tile-accent">{totalSold.toLocaleString()}</div>
            <div className="tile-sub">この検索で観測した売却数</div>
          </div>
          <div className="tile">
            <div className="tile-label">
              <IconFlame size={12} />
              穴場候補
            </div>
            <div className="tile-value tile-pos">{hotCount.toLocaleString()}</div>
            <div className="tile-sub">1ジャンルに絞って売れている</div>
          </div>
          <div className="tile">
            <div className="tile-label">
              <IconClock size={12} />
              NG基準
            </div>
            <div className="tile-value" style={{ fontSize: 15 }}>
              新品{ngNewRate}% / {ngTurnover}日
            </div>
            <div className="tile-sub">これを外れる行は薄く表示</div>
          </div>
        </div>
      )}

      {search && (
        <div className="toolbar">
          <span className="pill pill-brand">直近の検索</span>
          <strong>{search.keywords}</strong>
          {search.aruaru_words && <span className="hint">あるあるワード: {search.aruaru_words}</span>}
          <span className="spacer" />
          {search.created_at && <span className="hint">{search.created_at}</span>}
        </div>
      )}

      {rows.length > 0 ? (
        <div className="table-wrap fade-up">
          <div className="table-scroll">
            {/* 見出しの並べ替えと「もっと見る」は SellerTable が持つ。
                行の中身はここ(サーバー側)で作り、並べ替えに使う値だけ keys で渡す */}
            <SellerTable step={5} keys={sortKeys}>
                {rows.map((r) => {
                  const slowRotation = r.turnover_days !== null && r.turnover_days > ngTurnover;
                  const lowNew = r.new_item_rate !== null && r.new_item_rate < ngNewRate;
                  const type = sellerTypePill(r.seller_type);
                  return (
                    <tr key={`${r.seller_id}-${r.matched_keyword ?? ""}`} data-ng={lowNew || slowRotation}>
                      <td>
                        <div className="seller-cell">
                          <Avatar name={r.seller_name} url={r.avatar_url} externalId={r.seller_external_id} />
                          <div style={{ minWidth: 0 }}>
                            <div className="name" title={r.seller_name}>
                              {r.seller_name}
                            </div>
                            <div className="sub">
                              {r.listing_count !== null ? `出品${r.listing_count.toLocaleString()}件` : `ID ${r.seller_external_id}`}
                              {r.genre_count !== null && ` ・ ${r.genre_count}ジャンル`}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="tight">
                        {type ? (
                          <span className={`pill ${type.cls}`}>
                            {type.cls === "pill-hot" && <IconFlame size={11} />}
                            {type.label}
                          </span>
                        ) : (
                          <span className="hint">-</span>
                        )}
                      </td>
                      <td className="tight right num" style={{ color: "var(--text-muted)" }}>
                        {r.review_count !== null ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <IconStar size={12} style={{ color: "#f5a623" }} />
                            {r.review_count.toLocaleString()}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="tight right num">
                        <span className="pill pill-brand">{r.total_sold}件</span>
                      </td>
                      <td className="tight right num">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <IconTag size={11} style={{ color: "var(--text-faint)" }} />¥
                          {Math.round(r.avg_price).toLocaleString()}
                        </span>
                      </td>
                      <td className="tight right num">
                        {r.turnover_days !== null ? (
                          <span className={`pill ${slowRotation ? "pill-warn" : "pill-good"}`}>
                            {r.turnover_days.toFixed(1)}日
                          </span>
                        ) : (
                          <span className="hint">-</span>
                        )}
                      </td>
                      <td className="tight right num">
                        {r.new_item_rate !== null ? (
                          <span className={`pill ${lowNew ? "pill-warn" : "pill-good"}`}>
                            <IconPie size={10} />
                            {Math.round(r.new_item_rate)}%
                          </span>
                        ) : (
                          <span className="hint">-</span>
                        )}
                      </td>
                      <td className="tight right">
                        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center" }}>
                          {r.profile_url && (
                            <a
                              className="link"
                              href={r.profile_url}
                              target="_blank"
                              rel="noreferrer"
                              title="メルカリのプロフィールを開く"
                              style={{ color: "var(--text-faint)" }}
                            >
                              <IconExternal size={13} />
                            </a>
                          )}
                          <Link href={`/seller-deepdive?seller_id=${r.seller_id}`} className="link">
                            深掘りへ
                            <IconArrowRight size={13} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </SellerTable>
          </div>
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

      {rows.length > 0 && (
        <p className="hint" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <IconAward size={12} />
          薄く表示されている行は、新品率が{ngNewRate}%未満、または回転日数が{ngTurnover}
          日より遅いセラーです(設定で変更できます)。
        </p>
      )}
    </div>
  );
}
