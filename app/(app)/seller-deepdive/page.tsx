import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "../../../lib/auth";
import Link from "next/link";
import {
  breakEvenPurchaseJpy,
  getSupabase,
  must,
  normalizeProductGroup,
  ProductGroupRow,
} from "../../../lib/db";
import Avatar from "../../Avatar";
import MigrationNotice from "../../MigrationNotice";
import RevealList from "../../RevealList";
import ScrapeRunner from "../../ScrapeRunner";
import {
  IconAlert,
  IconArrowUp,
  IconAward,
  IconBox,
  IconCalendar,
  IconClock,
  IconExternal,
  IconFlame,
  IconInbox,
  IconLayers,
  IconRepeat,
  IconSave,
  IconStar,
  IconTag,
  IconTarget,
  IconTruck,
  IconUsers,
} from "../../icons";

export const dynamic = "force-dynamic"; // DBの最新状態を毎回読むため静的化しない

async function saveToDeepdive(formData: FormData) {
  "use server";
  // ログインしていない人にデータを書き換えさせない(画面を通らず直接叩かれる経路への備え)
  if (!(await currentUser())) redirect("/login");
  const productGroupId = Number(formData.get("product_group_id"));
  // 元: INSERT INTO deepdive_items (product_group_id, order_qty, fee_rate_pct, domestic_shipping_jpy)
  //     VALUES (?, 1, 10, 210)
  //
  // 送料は、そのグループで実際に取れた実送料があればそれを初期値にする。
  // 固定の210円で入れると、ネコポス以外の商品で利益計算が最初からずれるため。
  const group = must(
    await getSupabase()
      .from("product_groups")
      .select("avg_shipping_cost, avg_price")
      .eq("id", productGroupId)
      .maybeSingle()
  ) as { avg_shipping_cost: number | null; avg_price: number | null } | null;

  must(
    await getSupabase()
      .from("deepdive_items")
      .insert({
        product_group_id: productGroupId,
        order_qty: 1,
        fee_rate_pct: 10,
        domestic_shipping_jpy: group?.avg_shipping_cost != null ? Math.round(group.avg_shipping_cost) : 210,
        shipping_jpy: group?.avg_shipping_cost != null ? Math.round(group.avg_shipping_cost) : null,
      })
      .select("id")
  );
  revalidatePath("/deepdive-list");
  revalidatePath("/seller-deepdive");
}

type Seller = {
  id: number;
  seller_name: string;
  seller_external_id: string;
  rating: number | null;
  review_count: number | null;
  good_ratings: number | null;
  bad_ratings: number | null;
  listing_count: number | null;
  avatar_url: string | null;
  profile_url: string | null;
};

/** 実送料の取得状況を、画面の言葉に直す */
function shipLabel(g: ProductGroupRow): { cls: string; text: string; hint: string } {
  const yen = g.avg_shipping_cost !== null ? `¥${Math.round(g.avg_shipping_cost).toLocaleString()}` : null;
  switch (g.ship_status) {
    case "got":
      return { cls: "pill-good", text: yen ?? "取得済み", hint: g.ship_class ?? "発送時に確定した実送料" };
    case "fixed":
      return { cls: "pill-good", text: yen ?? "一律", hint: "全国一律の配送方法" };
    case "failed":
      return { cls: "pill-warn", text: "送料待ち", hint: "メルカリ便だが金額が公開されていない" };
    case "na":
      return { cls: "pill-mute", text: "—", hint: "普通郵便・定形外など、金額が公開されない発送方法" };
    default:
      // まだ取りに行っていない。以前の取得で金額だけ残っていることがある
      return yen
        ? { cls: "pill-good", text: yen, hint: "以前の取得で分かっている実送料" }
        : { cls: "pill-mute", text: "—", hint: "この商品は実送料を取得していません(上位N件のみ取得)" };
  }
}

function fmtDate(v: string | null): string | null {
  if (!v) return null;
  return v.slice(0, 10);
}

export default async function SellerDeepdivePage({
  searchParams,
}: {
  searchParams: { seller_id?: string };
}) {
  const sellerId = Number(searchParams.seller_id ?? 0);
  let groups: ProductGroupRow[] = [];
  let seller: Seller | null = null;
  let savedGroupIds = new Set<number>();
  let needsMigration = false;
  let error: string | null = null;

  try {
    const db = getSupabase();
    if (sellerId) {
      // 列を並べずに * で読むのは、schema.sql をまだ適用していないDBでも
      // 「その列が無い」だけで済ませるため(列名を指定するとクエリ自体が失敗する)
      const sellerRow = must(
        await db.from("sellers").select("*").eq("id", sellerId).maybeSingle()
      ) as Record<string, unknown> | null;
      if (sellerRow) {
        const num = (v: unknown) => (typeof v === "number" ? v : null);
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        seller = {
          id: Number(sellerRow.id),
          seller_name: String(sellerRow.seller_name ?? ""),
          seller_external_id: String(sellerRow.seller_external_id ?? ""),
          rating: num(sellerRow.rating),
          review_count: num(sellerRow.review_count),
          good_ratings: num(sellerRow.good_ratings),
          bad_ratings: num(sellerRow.bad_ratings),
          listing_count: num(sellerRow.listing_count),
          avatar_url: str(sellerRow.avatar_url),
          profile_url: str(sellerRow.profile_url),
        };
        // 後から足した列が1つも無ければ、スキーマが未適用と判断する
        needsMigration = !("avatar_url" in sellerRow);
      }
      // 鉄板候補(繰り返し出品)を先に、その中では売れている順に並べる
      groups = ((must(
        await db
          .from("product_groups")
          .select("*")
          .eq("seller_id", sellerId)
          .order("is_repeat", { ascending: false })
          .order("sold_count", { ascending: false })
          .order("listing_count", { ascending: false })
      ) ?? []) as Record<string, unknown>[]).map(normalizeProductGroup);

      // 既に深掘りリストへ保存済みのグループを調べて、ボタンの表示を変える
      const saved = (must(
        await db
          .from("deepdive_items")
          .select("product_group_id")
          .in("product_group_id", groups.length ? groups.map((g) => g.id) : [0])
      ) ?? []) as { product_group_id: number }[];
      savedGroupIds = new Set(saved.map((s) => s.product_group_id));
    }
  } catch (e) {
    error = String(e);
  }

  const repeats = groups.filter((g) => g.is_repeat);
  const totalSold = groups.reduce((a, g) => a + g.sold_count, 0);
  const inStock = groups.reduce((a, g) => a + (g.stock_count ?? 0), 0);
  const withShipping = groups.filter((g) => g.avg_shipping_cost !== null).length;

  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1 className="page-title">
          <IconLayers size={20} />
          セラー深掘り
        </h1>
        <p className="page-desc">
          {sellerId ? (
            <>
              同じ商品タイトルを繰り返し出品している商品(<strong>再出品2件以上</strong>
              )を鉄板商品候補として表示します。良さそうなものは「深掘りリストへ保存」で③に送ります。
            </>
          ) : (
            "①のセラーリサーチから「深掘りへ」で遷移してください。"
          )}
        </p>
      </div>

      {seller && (
        <>
          <div className="card card-pad fade-up" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <Avatar
                name={seller.seller_name}
                url={seller.avatar_url}
                externalId={seller.seller_external_id}
                size="lg"
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 3 }}>{seller.seller_name}</div>
                <div className="meta">
                  {seller.rating !== null && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                      <IconStar size={12} style={{ color: "#f5a623" }} />
                      {seller.rating.toFixed(1)}
                    </span>
                  )}
                  {seller.review_count !== null && (
                    <>
                      <span className="sep">・</span>
                      <span>評価 {seller.review_count.toLocaleString()}件</span>
                    </>
                  )}
                  {seller.good_ratings !== null && seller.bad_ratings !== null && (
                    <>
                      <span className="sep">・</span>
                      <span style={{ color: "var(--green)" }}>良 {seller.good_ratings.toLocaleString()}</span>
                      <span style={{ color: "var(--red)" }}>悪 {seller.bad_ratings.toLocaleString()}</span>
                    </>
                  )}
                  {seller.listing_count !== null && (
                    <>
                      <span className="sep">・</span>
                      <span>総出品 {seller.listing_count.toLocaleString()}件</span>
                    </>
                  )}
                  <span className="sep">・</span>
                  <span className="hint">ID {seller.seller_external_id}</span>
                  {seller.profile_url && (
                    <>
                      <span className="sep">・</span>
                      <a className="link" href={seller.profile_url} target="_blank" rel="noreferrer">
                        メルカリで開く
                        <IconExternal size={12} />
                      </a>
                    </>
                  )}
                </div>
              </div>
              <Link href="/" className="btn btn-ghost btn-sm">
                <IconUsers size={13} />
                セラー一覧へ
              </Link>
            </div>
          </div>

          {groups.length > 0 && (
            <div className="tiles fade-up">
              <div className="tile">
                <div className="tile-label">
                  <IconFlame size={12} />
                  鉄板候補
                </div>
                <div className="tile-value tile-accent">{repeats.length}</div>
                <div className="tile-sub">2回以上出品している商品</div>
              </div>
              <div className="tile">
                <div className="tile-label">
                  <IconLayers size={12} />
                  商品グループ
                </div>
                <div className="tile-value">{groups.length}</div>
                <div className="tile-sub">同一商品をまとめた数</div>
              </div>
              <div className="tile">
                <div className="tile-label">
                  <IconBox size={12} />
                  SOLD / 販売中
                </div>
                <div className="tile-value">
                  {totalSold}
                  <span style={{ fontSize: 13, color: "var(--text-faint)", fontWeight: 500 }}> / {inStock}</span>
                </div>
                <div className="tile-sub">取得した出品の内訳</div>
              </div>
              <div className="tile">
                <div className="tile-label">
                  <IconTruck size={12} />
                  実送料を取得
                </div>
                <div className="tile-value">
                  {withShipping}
                  <span style={{ fontSize: 13, color: "var(--text-faint)", fontWeight: 500 }}> / {groups.length}</span>
                </div>
                <div className="tile-sub">上位N件だけ取りに行く設計</div>
              </div>
            </div>
          )}

          <ScrapeRunner
            kind="seller"
            payload={{ seller_external_id: seller.seller_external_id, max: 100, shipping: 3 }}
            buttonLabel="このセラーの出品を再取得"
            title="メルカリから最新の出品を取り直す"
            description="このセラーの出品を新しい順に最大100件取得し、鉄板商品の抽出まで自動で行います。SOLD上位3件は実送料も調べます。"
            withDepthChoice
          />
        </>
      )}

      {needsMigration && <MigrationNotice what="アバター・実送料の取得状況・実測月販" />}

      {error && (
        <div className="note note-error">
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      <div className="stack">
        {/* 最初は10件だけ。「もっと見る」で10件ずつ増やす */}
        <RevealList step={10} unit="件">
        {groups.map((g) => {
          const saved = savedGroupIds.has(g.id);
          const ship = shipLabel(g);
          const breakEven = breakEvenPurchaseJpy(g.avg_price, g.avg_shipping_cost, 10);
          const priceSpread =
            g.min_price !== null && g.max_price !== null && g.max_price > g.min_price
              ? `¥${Math.round(g.min_price).toLocaleString()}〜¥${Math.round(g.max_price).toLocaleString()}`
              : null;
          const firstListed = fmtDate(g.first_listed_at);
          const latestSold = fmtDate(g.latest_sold_at);
          const titles = Array.isArray(g.merged_titles) ? g.merged_titles : [];

          return (
            <div key={g.id} className={`card card-pad fade-up ${g.is_repeat ? "card-repeat" : ""}`}>
              <div className="group-head">
                <div style={{ display: "flex", gap: 12, minWidth: 0 }}>
                  {g.representative_image_url ? (
                    g.representative_listing_url ? (
                      <a
                        className="thumb-link"
                        href={g.representative_listing_url}
                        target="_blank"
                        rel="noreferrer"
                        title="メルカリの商品ページを開く"
                      >
                        <img className="thumb" src={g.representative_image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      </a>
                    ) : (
                      <img className="thumb" src={g.representative_image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    )
                  ) : (
                    <div className="thumb" />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="item-title">
                      {g.representative_listing_url ? (
                        <a
                          href={g.representative_listing_url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "inherit", textDecoration: "none" }}
                        >
                          {g.representative_title}
                        </a>
                      ) : (
                        <span>{g.representative_title}</span>
                      )}
                      {g.is_repeat ? (
                        <span className="pill pill-hot">
                          <IconFlame size={11} />
                          鉄板候補
                        </span>
                      ) : null}
                      {(g.distinct_title_count ?? 0) >= 2 && (
                        <span className="pill pill-info" title="タイトルを少しずつ変えて出し直しています">
                          <IconRepeat size={11} />
                          {g.distinct_title_count}種のタイトル
                        </span>
                      )}
                      {(g.stock_count ?? 0) > 0 && (
                        <span className="pill pill-mute" title="今も販売中の在庫があります">
                          販売中{g.stock_count}
                        </span>
                      )}
                    </div>
                    {priceSpread && <div className="hint">価格レンジ {priceSpread}</div>}
                    {titles.length > 1 && (
                      <details className="titles">
                        <summary>まとめた{titles.length}件のタイトルを見る</summary>
                        <ul>
                          {titles.map((t, i) => (
                            <li key={i}>{t}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </div>
                <form action={saveToDeepdive}>
                  <input type="hidden" name="product_group_id" value={g.id} />
                  <button type="submit" className={saved ? "btn btn-ghost" : "btn btn-primary"}>
                    <IconSave size={14} />
                    {saved ? "もう一度保存" : "深掘りリストへ保存"}
                  </button>
                </form>
              </div>

              <div className="group-stats">
                <div className="gs">
                  <div className="gs-label">
                    <IconRepeat size={10} />
                    出品数
                  </div>
                  <div className="gs-value">{g.listing_count}回</div>
                </div>
                <div className="gs">
                  <div className="gs-label">
                    <IconBox size={10} />
                    SOLD
                  </div>
                  <div className="gs-value" style={{ color: "var(--green)" }}>
                    {g.sold_count}件
                  </div>
                </div>
                <div className="gs">
                  <div className="gs-label">
                    <IconTag size={10} />
                    平均価格
                  </div>
                  <div className="gs-value">
                    {g.avg_price !== null ? `¥${Math.round(g.avg_price).toLocaleString()}` : "-"}
                  </div>
                </div>
                <div className="gs">
                  <div className="gs-label">
                    <IconClock size={10} />
                    回転日数
                  </div>
                  <div className={`gs-value ${g.avg_turnover_days === null ? "muted" : ""}`}>
                    {g.avg_turnover_days !== null ? `${g.avg_turnover_days.toFixed(1)}日` : "—"}
                  </div>
                </div>
                <div className="gs">
                  <div className="gs-label">
                    <IconArrowUp size={10} />
                    実測月販
                  </div>
                  <div className={`gs-value ${g.sold_per_month === null ? "muted" : ""}`}>
                    {g.sold_per_month !== null ? `${g.sold_per_month.toFixed(1)}個` : "—"}
                  </div>
                </div>
                <div className="gs">
                  <div className="gs-label">
                    <IconTruck size={10} />
                    実送料
                  </div>
                  <div className="gs-value">
                    <span className={`pill ${ship.cls}`} title={ship.hint}>
                      {ship.text}
                    </span>
                  </div>
                </div>
                <div className="gs">
                  <div className="gs-label">
                    <IconTarget size={10} />
                    黒字ライン
                  </div>
                  <div className={`gs-value ${breakEven === null ? "muted" : ""}`}>
                    {breakEven !== null ? `¥${breakEven.toLocaleString()}` : "送料待ち"}
                  </div>
                </div>
                <div className="gs">
                  <div className="gs-label">
                    <IconCalendar size={10} />
                    最新SOLD
                  </div>
                  <div className={`gs-value ${latestSold === null ? "muted" : ""}`} style={{ fontSize: 12 }}>
                    {latestSold ?? "—"}
                  </div>
                </div>
                {firstListed && (
                  <div className="gs">
                    <div className="gs-label">
                      <IconCalendar size={10} />
                      初回出品
                    </div>
                    <div className="gs-value muted" style={{ fontSize: 12 }}>
                      {firstListed}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        </RevealList>

        {groups.length === 0 && !error && (
          <div className="empty">
            <IconInbox size={30} />
            <div>{sellerId ? "このセラーの出品データがまだありません。" : "セラーが選択されていません。"}</div>
            <div style={{ fontSize: 12.5, marginTop: 4 }}>
              {sellerId
                ? "上の「このセラーの出品を再取得」を押すとメルカリから取得します。"
                : "①セラーリサーチの一覧から「深掘りへ」を押してください。"}
            </div>
          </div>
        )}
      </div>

      {groups.length > 0 && (
        <p className="hint" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 6 }}>
          <IconAward size={12} />
          「黒字ライン」は、平均価格 −
          販売手数料10% − 実送料 で計算した仕入値の上限です。実送料が取れていない商品は判断材料が足りないので出しません。
        </p>
      )}
    </div>
  );
}
