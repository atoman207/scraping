import { revalidatePath } from "next/cache";
import { getSupabase, must, ProductGroupRow } from "../../lib/db";
import ScrapeRunner from "../ScrapeRunner";
import {
  IconAlert,
  IconClock,
  IconExternal,
  IconInbox,
  IconLayers,
  IconSave,
  IconTag,
  IconTruck,
} from "../icons";

export const dynamic = "force-dynamic"; // DBの最新状態を毎回読むため静的化しない

async function saveToDeepdive(formData: FormData) {
  "use server";
  const productGroupId = Number(formData.get("product_group_id"));
  // 元: INSERT INTO deepdive_items (product_group_id, order_qty, fee_rate_pct, domestic_shipping_jpy)
  //     VALUES (?, 1, 10, 210)
  must(
    await getSupabase()
      .from("deepdive_items")
      .insert({ product_group_id: productGroupId, order_qty: 1, fee_rate_pct: 10, domestic_shipping_jpy: 210 })
      .select("id")
  );
  revalidatePath("/deepdive-list");
  revalidatePath("/seller-deepdive");
}

type Seller = {
  id: number;
  seller_name: string;
  seller_external_id: string;
  review_count: number | null;
  profile_url: string | null;
};

export default async function SellerDeepdivePage({
  searchParams,
}: {
  searchParams: { seller_id?: string };
}) {
  const sellerId = Number(searchParams.seller_id ?? 0);
  let groups: ProductGroupRow[] = [];
  let seller: Seller | null = null;
  let savedGroupIds = new Set<number>();
  let error: string | null = null;

  try {
    const db = getSupabase();
    if (sellerId) {
      seller = must(
        await db
          .from("sellers")
          .select("id, seller_name, seller_external_id, review_count, profile_url")
          .eq("id", sellerId)
          .maybeSingle()
      ) as Seller | null;
      // 元: SELECT * FROM product_groups WHERE seller_id = ? ORDER BY sold_count DESC, listing_count DESC
      groups = (must(
        await db
          .from("product_groups")
          .select("*")
          .eq("seller_id", sellerId)
          .order("sold_count", { ascending: false })
          .order("listing_count", { ascending: false })
      ) ?? []) as ProductGroupRow[];

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

  return (
    <div className="page">
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
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{seller.seller_name}</div>
                <div className="meta">
                  <span>ID: {seller.seller_external_id}</span>
                  {seller.review_count !== null && (
                    <>
                      <span className="sep">・</span>
                      <span>評価 {seller.review_count.toLocaleString()}</span>
                    </>
                  )}
                  <span className="sep">・</span>
                  <span>
                    出品グループ {groups.length}件 / 鉄板候補 {repeats.length}件
                  </span>
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
            </div>
          </div>

          <ScrapeRunner
            kind="seller"
            payload={{ seller_external_id: seller.seller_external_id, max: 100, shipping: 3 }}
            buttonLabel="このセラーの出品を再取得"
            title="メルカリから最新の出品を取り直す"
            description="このセラーの出品を最大100件取得し、鉄板商品の抽出まで自動で行います。SOLD上位3件は実送料も調べます。"
          />
        </>
      )}

      {error && (
        <div className="note note-error">
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      <div className="stack">
        {groups.map((g) => {
          const saved = savedGroupIds.has(g.id);
          return (
            <div key={g.id} className={`card card-pad ${g.is_repeat ? "card-repeat" : ""}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14 }}>
                <div style={{ display: "flex", gap: 12, minWidth: 0 }}>
                  {g.representative_image_url ? (
                    <img className="thumb" src={g.representative_image_url} alt="" />
                  ) : (
                    <div className="thumb" />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div className="item-title">
                      <span>{g.representative_title}</span>
                      {g.is_repeat ? (
                        <span className="badge badge-brand">鉄板候補・再出品{g.listing_count}回</span>
                      ) : null}
                    </div>
                    <div className="meta">
                      <span>
                        SOLD <strong style={{ color: "var(--text)" }}>{g.sold_count}</strong>件
                      </span>
                      <span className="sep">・</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <IconTag size={12} />
                        平均 ¥{g.avg_price ? Math.round(g.avg_price).toLocaleString() : "-"}
                      </span>
                      <span className="sep">・</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <IconClock size={12} />
                        {g.avg_turnover_days ? `${g.avg_turnover_days.toFixed(1)}日` : "回転日数-"}
                      </span>
                      <span className="sep">・</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <IconTruck size={12} />
                        {g.avg_shipping_cost ? `¥${Math.round(g.avg_shipping_cost)}` : "送料未取得"}
                      </span>
                    </div>
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
            </div>
          );
        })}

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
    </div>
  );
}
