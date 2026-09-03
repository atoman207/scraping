import { revalidatePath } from "next/cache";
import { getSupabase, must, getDeepdiveListV2, getSettings, Settings, DeepdiveComputed } from "../../lib/db";
import { TARIFF_CATEGORIES } from "../../lib/engine/cost";
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

/** 空文字を null にして返す(未入力と 0 を区別するため) */
function numOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function updateCost(formData: FormData) {
  "use server";
  const id = Number(formData.get("deepdive_id"));
  must(
    await getSupabase()
      .from("deepdive_items")
      .update({
        cost_mode: String(formData.get("cost_mode") || "detail"),
        cost_direct_jpy: numOrNull(formData.get("cost_direct_jpy")),
        unit_cost_cny: numOrNull(formData.get("unit_cost_cny")),
        china_domestic_cny: numOrNull(formData.get("china_domestic_cny")),
        tariff_cat: String(formData.get("tariff_cat") || "other"),
        box_count: numOrNull(formData.get("box_count")),
        order_qty: numOrNull(formData.get("order_qty")) ?? 1,
        sell_price_jpy: numOrNull(formData.get("sell_price_jpy")),
        shipping_jpy: numOrNull(formData.get("shipping_jpy")),
        fee_rate_pct: numOrNull(formData.get("fee_rate_pct")) ?? 10,
        packaging_jpy: numOrNull(formData.get("packaging_jpy")) ?? 0,
        monthly_qty: numOrNull(formData.get("monthly_qty")),
        source_url: String(formData.get("source_url") || ""),
      })
      .eq("id", id)
      .select("id")
  );
  revalidatePath("/deepdive-list");
}

async function updateSettings(formData: FormData) {
  "use server";
  must(
    await getSupabase()
      .from("settings")
      .update({
        exchange_rate_jpy_per_cny: Number(formData.get("exchange_rate")),
        agent_fee_pct: Number(formData.get("agent_fee_pct")),
        intl_shipping_cny_per_kg: Number(formData.get("intl_shipping")),
        box_weight_kg: Number(formData.get("box_weight")),
        import_tax_pct: numOrNull(formData.get("import_tax_pct")) ?? 0,
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

function yen(n: number | null | undefined) {
  if (n === null || n === undefined) return "-";
  return `¥${Math.round(n).toLocaleString()}`;
}

/** 原価の内訳を1行の文章にする。画面の「原価」の下に小さく出す。 */
function breakdownText(item: DeepdiveComputed): string | null {
  const b = item.cost_breakdown;
  if (!b) return null;
  const r = (n: number) => `¥${Math.round(n).toLocaleString()}`;
  const tPct = TARIFF_CATEGORIES[(item.tariff_cat ?? "other") as keyof typeof TARIFF_CATEGORIES]?.pct ?? 5;
  const parts = [
    `商品 ${r(b.item)}`,
    `代行${item.agent_fee_pct}% ${r(b.agentFee)}`,
    `中国国内送料 ${r(b.domestic)}`,
    `関税${tPct}% ${r(b.tariff)}`,
    `国際送料 ${r(b.intlShipping)}`,
  ];
  if (b.importTax > 0) parts.push(`輸入消費税${item.import_tax_pct}% ${r(b.importTax)}`);
  return parts.join(" ＋ ") + ` ＝ ${r(item.cost_jpy ?? 0)}`;
}

export default async function DeepdiveListPage() {
  let items: DeepdiveComputed[] = [];
  let settings: Settings | null = null;
  let error: string | null = null;
  try {
    items = await getDeepdiveListV2();
    settings = await getSettings();
  } catch (e) {
    error = String(e);
  }

  const profitable = items.filter((i) => (i.profit_per_unit ?? -1) > 0).length;
  const waiting = items.filter((i) => i.profit_per_unit === null).length;

  return (
    <div className="page-wide">
      <div className="page-head">
        <h1 className="page-title">
          <IconCalculator size={20} />
          深掘りリスト
        </h1>
        <p className="page-desc">
          仕入単価(元)を入れると、共通設定(為替・代行手数料・国際送料)と関税・中国国内送料から着地原価を計算し、
          1個利益・月利益・黒字ライン仕入値を出します。仕入先が分からない商品は「仕入れ候補を探す」で候補を引けます。
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
              {settings.import_tax_pct ? ` ・ 輸入消費税 ${settings.import_tax_pct}%` : ""}
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
            <label className="field">
              輸入消費税(%)
              <input
                className="input"
                name="import_tax_pct"
                type="number"
                step="0.1"
                defaultValue={settings.import_tax_pct ?? 0}
              />
            </label>
            <button type="submit" className="btn btn-primary">
              更新
            </button>
          </form>
          <p className="page-desc" style={{ marginTop: 10, marginBottom: 0, fontSize: 12.5 }}>
            輸入消費税は既定 0%（計上しない）です。実際に納めている場合だけ 10 を入れてください。
            課税価格(商品代＋国際送料)＋関税 に対してかかります。
          </p>
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
          {items.length - profitable - waiting > 0 && (
            <span className="badge badge-red">赤字 {items.length - profitable - waiting}件</span>
          )}
          {waiting > 0 && <span className="badge badge-muted">入力待ち {waiting}件</span>}
        </div>
      )}

      <div className="stack">
        {items.map((item) => {
          const isProfit = (item.profit_per_unit ?? -1) > 0;
          const bd = breakdownText(item);
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
                      {item.avg_turnover_days ? `回転 ${item.avg_turnover_days.toFixed(1)}日` : "回転日数-"}
                    </span>
                    <span className="sep">・</span>
                    <span>SOLD {item.sold_count}件</span>
                    {item.listing_count >= 2 && (
                      <>
                        <span className="sep">・</span>
                        <span className="badge badge-green">鉄板 出品{item.listing_count}回</span>
                      </>
                    )}
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

              <form action={updateCost}>
                <input type="hidden" name="deepdive_id" value={item.deepdive_id} />

                <div className="form-row" style={{ marginBottom: 8 }}>
                  <label className="field">
                    原価の出し方
                    <select className="input" name="cost_mode" defaultValue={item.cost_mode ?? "detail"}>
                      <option value="detail">詳細式(単価・送料・関税から)</option>
                      <option value="direct">原価を直接入力</option>
                    </select>
                  </label>
                  <label className="field">
                    商品単価(元)
                    <input
                      className="input"
                      name="unit_cost_cny"
                      type="number"
                      step="0.01"
                      defaultValue={item.unit_cost_cny ?? ""}
                    />
                  </label>
                  <label className="field">
                    中国国内送料(元)
                    <input
                      className="input"
                      name="china_domestic_cny"
                      type="number"
                      step="0.01"
                      defaultValue={item.china_domestic_cny ?? ""}
                    />
                  </label>
                  <label className="field">
                    関税区分
                    <select className="input" name="tariff_cat" defaultValue={item.tariff_cat ?? "other"}>
                      {Object.entries(TARIFF_CATEGORIES).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v.label} {v.pct}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    箱入数(個)
                    <input className="input" name="box_count" type="number" defaultValue={item.box_count ?? ""} />
                  </label>
                  <label className="field">
                    原価を直接(円)
                    <input
                      className="input"
                      name="cost_direct_jpy"
                      type="number"
                      defaultValue={item.cost_direct_jpy ?? ""}
                    />
                  </label>
                </div>

                <div className="form-row" style={{ marginBottom: 8 }}>
                  <label className="field">
                    売価(円)
                    <input
                      className="input"
                      name="sell_price_jpy"
                      type="number"
                      placeholder={item.mercari_avg_price ? String(Math.round(item.mercari_avg_price)) : ""}
                      defaultValue={item.sell_price_jpy ?? ""}
                    />
                  </label>
                  <label className="field">
                    送料(円)
                    <input className="input" name="shipping_jpy" type="number" defaultValue={item.shipping_jpy ?? ""} />
                  </label>
                  <label className="field">
                    販売手数料(%)
                    <input
                      className="input"
                      name="fee_rate_pct"
                      type="number"
                      step="0.1"
                      defaultValue={item.fee_rate_pct}
                    />
                  </label>
                  <label className="field">
                    梱包費(円)
                    <input className="input" name="packaging_jpy" type="number" defaultValue={item.packaging_jpy ?? 0} />
                  </label>
                  <label className="field">
                    予想月販(個)
                    <input
                      className="input"
                      name="monthly_qty"
                      type="number"
                      step="0.1"
                      placeholder={item.monthly_qty_auto !== null ? `自動 ${item.monthly_qty_auto}` : ""}
                      defaultValue={item.monthly_qty ?? ""}
                    />
                  </label>
                  <label className="field">
                    発注数(個)
                    <input className="input" name="order_qty" type="number" defaultValue={item.order_qty} />
                  </label>
                </div>

                <div className="form-row" style={{ marginBottom: 4 }}>
                  <label className="field" style={{ flex: 1, minWidth: 260 }}>
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
                </div>
              </form>

              <div className="metrics">
                <div>
                  <div className="metric-label">着地原価</div>
                  <div className="metric-value">{yen(item.cost_jpy)}</div>
                </div>
                <div>
                  <div className="metric-label">黒字ライン原価</div>
                  <div className="metric-value">
                    {yen(item.breakeven_cost_jpy)}
                    {item.breakeven_item_cny !== null && (
                      <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-faint)" }}>
                        {" "}
                        (単価 {item.breakeven_item_cny}元まで)
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="metric-label">1個利益</div>
                  <div className={`metric-value ${item.profit_per_unit === null ? "" : isProfit ? "pos" : "neg"}`}>
                    {item.profit_per_unit === null ? (item.reason ?? "-") : yen(item.profit_per_unit)}
                  </div>
                </div>
                <div>
                  <div className="metric-label">
                    月利益(目安)
                    {item.monthly_qty_used !== null && (
                      <span style={{ fontWeight: 400 }}>
                        {" "}
                        ・月{item.monthly_qty_used}個
                        {item.monthly_qty_source === "manual" ? "(手入力)" : ""}
                      </span>
                    )}
                  </div>
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

              {bd && (
                <div className="meta" style={{ marginTop: 8, fontSize: 12 }}>
                  原価の内訳: {bd}
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <ScrapeRunner
                  kind="sourcing"
                  payload={{ product_group_id: item.product_group_id, apply: true }}
                  buttonLabel="AliExpressで仕入れ候補を探す"
                  title="仕入れ候補の自動検索"
                  description="商品タイトルからAliExpressを検索し、最安候補の価格(元)と仕入先URLをこの行に反映します。1688は検索リンクのみ表示します。"
                  compact
                />
              </div>
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
            国際送料(元/個) = 国際送料(元/kg) × 箱重量 ÷ 箱入数。
            着地原価 =(商品単価 + 代行手数料 + 中国国内送料 + 関税 + 国際送料)× 為替。
            1個利益 = 売価 − 販売手数料 − 送料 − 梱包費 − 着地原価。
            月利益 = 1個利益 × 予想月販(= 30 ÷ 回転日数。回転は最短0.5日として頭打ち)。
          </span>
        </div>
      )}
    </div>
  );
}
