import { revalidatePath } from "next/cache";
import { getSupabase, must, getDeepdiveList, getSettings, Settings } from "../../lib/db";
import ScrapeRunner from "../ScrapeRunner";
import {
  IconAlert,
  IconCalculator,
  IconCart,
  IconClock,
  IconExternal,
  IconInbox,
  IconSettings,
  IconTag,
} from "../icons";

export const dynamic = "force-dynamic"; // DBの最新状態を毎回読むため静的化しない

async function updateCost(formData: FormData) {
  "use server";
  const id = Number(formData.get("deepdive_id"));
  const unitCostCny = formData.get("unit_cost_cny") ? Number(formData.get("unit_cost_cny")) : null;
  const orderQty = Number(formData.get("order_qty") || 1);
  const sourceUrl = String(formData.get("source_url") || "");
  // 元: UPDATE deepdive_items SET unit_cost_cny = ?, order_qty = ?, source_url = ? WHERE id = ?
  must(
    await getSupabase()
      .from("deepdive_items")
      .update({ unit_cost_cny: unitCostCny, order_qty: orderQty, source_url: sourceUrl })
      .eq("id", id)
      .select("id")
  );
  revalidatePath("/deepdive-list");
}

async function updateSettings(formData: FormData) {
  "use server";
  // 元: UPDATE settings SET exchange_rate_jpy_per_cny=?, agent_fee_pct=?,
  //     intl_shipping_cny_per_kg=?, box_weight_kg=? WHERE id=1
  must(
    await getSupabase()
      .from("settings")
      .update({
        exchange_rate_jpy_per_cny: Number(formData.get("exchange_rate")),
        agent_fee_pct: Number(formData.get("agent_fee_pct")),
        intl_shipping_cny_per_kg: Number(formData.get("intl_shipping")),
        box_weight_kg: Number(formData.get("box_weight")),
      })
      .eq("id", 1)
      .select("id")
  );
  revalidatePath("/deepdive-list");
}

async function removeItem(formData: FormData) {
  "use server";
  const id = Number(formData.get("deepdive_id"));
  must(await getSupabase().from("deepdive_items").delete().eq("id", id).select("id"));
  revalidatePath("/deepdive-list");
}

function yen(n: number | null) {
  if (n === null || n === undefined) return "-";
  return `¥${Math.round(n).toLocaleString()}`;
}

export default async function DeepdiveListPage() {
  let items: Awaited<ReturnType<typeof getDeepdiveList>> = [];
  let settings: Settings | null = null;
  let groupIds = new Map<number, number>();
  let error: string | null = null;
  try {
    items = await getDeepdiveList();
    settings = await getSettings();
    // 仕入れ候補検索に渡すため、deepdive_id → product_group_id を引いておく
    const rows = (must(
      await getSupabase()
        .from("deepdive_items")
        .select("id, product_group_id")
        .in("id", items.length ? items.map((i) => i.deepdive_id) : [0])
    ) ?? []) as { id: number; product_group_id: number }[];
    groupIds = new Map(rows.map((r) => [r.id, r.product_group_id]));
  } catch (e) {
    error = String(e);
  }

  const profitable = items.filter((i) => (i.profit_per_unit ?? -1) > 0).length;

  return (
    <div className="page-wide">
      <div className="page-head">
        <h1 className="page-title">
          <IconCalculator size={20} />
          深掘りリスト
        </h1>
        <p className="page-desc">
          仕入単価(元)と発注数を入れると、共通設定(為替・代行手数料・国際送料)から自動で1個利益・月利益を計算します。
          仕入先が分からない商品は「仕入れ候補を探す」でAliExpressから候補を引けます。
        </p>
      </div>

      {settings && (
        <details className="card card-pad settings" style={{ marginBottom: 18 }}>
          <summary>
            <IconSettings size={15} style={{ color: "var(--brand)" }} />
            原価計算の共通設定
            <span style={{ fontWeight: 400, color: "var(--text-faint)", fontSize: 12 }}>
              為替 {settings.exchange_rate_jpy_per_cny}円/元 ・ 代行 {settings.agent_fee_pct}% ・ 国際送料{" "}
              {settings.intl_shipping_cny_per_kg}元/kg ・ 箱 {settings.box_weight_kg}kg
            </span>
          </summary>
          <form action={updateSettings} className="form-row" style={{ marginTop: 14 }}>
            <label className="field">
              為替レート(円/元)
              <input
                className="input"
                name="exchange_rate"
                type="number"
                step="0.1"
                defaultValue={settings.exchange_rate_jpy_per_cny}
              />
            </label>
            <label className="field">
              代行手数料(%)
              <input className="input" name="agent_fee_pct" type="number" step="0.1" defaultValue={settings.agent_fee_pct} />
            </label>
            <label className="field">
              国際送料(元/kg)
              <input
                className="input"
                name="intl_shipping"
                type="number"
                step="0.1"
                defaultValue={settings.intl_shipping_cny_per_kg}
              />
            </label>
            <label className="field">
              箱重量(kg)
              <input className="input" name="box_weight" type="number" step="0.1" defaultValue={settings.box_weight_kg} />
            </label>
            <button type="submit" className="btn btn-primary">
              更新
            </button>
          </form>
        </details>
      )}

      {error && (
        <div className="note note-error">
          <IconAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      {items.length > 0 && (
        <div className="meta" style={{ marginBottom: 12 }}>
          <span className="badge badge-muted">{items.length}件</span>
          {profitable > 0 && <span className="badge badge-green">黒字 {profitable}件</span>}
          {items.length - profitable > 0 && (
            <span className="badge badge-red">赤字・未入力 {items.length - profitable}件</span>
          )}
        </div>
      )}

      <div className="stack">
        {items.map((item) => {
          const isProfit = (item.profit_per_unit ?? -1) > 0;
          const groupId = groupIds.get(item.deepdive_id);
          return (
            <div key={item.deepdive_id} className="card card-pad">
              <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                {item.representative_image_url ? (
                  <img className="thumb" src={item.representative_image_url} alt="" />
                ) : (
                  <div className="thumb" />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="item-title">{item.representative_title}</div>
                  <div className="meta">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <IconTag size={12} />
                      メルカリ平均 {yen(item.mercari_avg_price)}
                    </span>
                    <span className="sep">・</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <IconClock size={12} />
                      {item.avg_turnover_days ? `${item.avg_turnover_days.toFixed(1)}日` : "回転日数-"}
                    </span>
                    <span className="sep">・</span>
                    <span>SOLD {item.sold_count}件</span>
                    {item.source_url && (
                      <>
                        <span className="sep">・</span>
                        <a className="link" href={item.source_url} target="_blank" rel="noreferrer">
                          仕入先
                          <IconExternal size={12} />
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <form action={removeItem}>
                  <input type="hidden" name="deepdive_id" value={item.deepdive_id} />
                  <button type="submit" className="btn btn-ghost btn-sm" title="このリストから削除">
                    削除
                  </button>
                </form>
              </div>

              <form action={updateCost} className="form-row" style={{ marginBottom: 4 }}>
                <input type="hidden" name="deepdive_id" value={item.deepdive_id} />
                <label className="field">
                  仕入単価(元)
                  <input
                    className="input"
                    name="unit_cost_cny"
                    type="number"
                    step="0.1"
                    defaultValue={item.unit_cost_cny ?? ""}
                  />
                </label>
                <label className="field">
                  発注数
                  <input className="input" name="order_qty" type="number" defaultValue={item.order_qty} />
                </label>
                <label className="field" style={{ flex: 1, minWidth: 220 }}>
                  仕入先URL(1688/AliExpress)
                  <input
                    className="input input-wide"
                    name="source_url"
                    type="text"
                    defaultValue={item.source_url ?? ""}
                  />
                </label>
                <button type="submit" className="btn btn-dark">
                  保存/再計算
                </button>
              </form>

              <div className="metrics">
                <div>
                  <div className="metric-label">黒字ライン仕入値</div>
                  <div className="metric-value">
                    {item.breakeven_unit_cost_cny !== null ? `${item.breakeven_unit_cost_cny}元` : "-"}
                  </div>
                </div>
                <div>
                  <div className="metric-label">1個利益</div>
                  <div className={`metric-value ${item.profit_per_unit === null ? "" : isProfit ? "pos" : "neg"}`}>
                    {yen(item.profit_per_unit)}
                  </div>
                </div>
                <div>
                  <div className="metric-label">月利益(目安)</div>
                  <div className={`metric-value ${item.monthly_profit === null ? "" : isProfit ? "pos" : "neg"}`}>
                    {yen(item.monthly_profit)}
                  </div>
                </div>
                <div style={{ marginLeft: "auto", alignSelf: "center" }}>
                  {item.profit_per_unit !== null &&
                    (isProfit ? (
                      <span className="badge badge-green">黒字</span>
                    ) : (
                      <span className="badge badge-red">赤字</span>
                    ))}
                </div>
              </div>

              {groupId && (
                <div style={{ marginTop: 12 }}>
                  <ScrapeRunner
                    kind="sourcing"
                    payload={{ product_group_id: groupId, apply: true }}
                    buttonLabel="AliExpressで仕入れ候補を探す"
                    title="仕入れ候補の自動検索"
                    description="商品タイトルからAliExpressを検索し、最安候補の価格(元)と仕入先URLをこの行に反映します。1688は検索リンクのみ表示します。"
                    compact
                  />
                </div>
              )}
            </div>
          );
        })}

        {items.length === 0 && !error && (
          <div className="empty">
            <IconInbox size={30} />
            <div>深掘りリストが空です。</div>
            <div style={{ fontSize: 12.5, marginTop: 4 }}>
              ②セラー深掘りから「深掘りリストへ保存」してください。
            </div>
          </div>
        )}
      </div>

      {items.length > 0 && (
        <div className="note note-info" style={{ marginTop: 20, marginBottom: 0 }}>
          <IconCart size={15} />
          <span>
            着地原価 =(仕入単価 ×(1+代行手数料) + 箱重量×国際送料÷発注数)× 為替。
            1個利益 = 売価 ×(1−販売手数料)− 国内送料 − 着地原価。月利益 = 1個利益 × 30 ÷ 回転日数。
          </span>
        </div>
      )}
    </div>
  );
}
