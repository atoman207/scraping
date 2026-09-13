import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "../../../lib/auth";
import {
  getSupabase,
  must,
  getDeepdiveListV2,
  getSettings,
  getSourcingCandidates,
  Settings,
  DeepdiveComputed,
  SourcingCandidateRow,
} from "../../../lib/db";
import { TARIFF_CATEGORIES } from "../../../lib/engine/cost";
import ScrapeRunner from "../../ScrapeRunner";
import { readStatus, statusLine } from "../../../lib/scraper/session-1688jp";
import {
  IconAlert,
  IconCart,
  IconCheck,
  IconClock,
  IconExternal,
  IconGlobe,
  IconImage,
  IconInbox,
  IconSearch,
  IconSettings,
  IconStar,
  IconTag,
} from "../../icons";

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
  // ログインしていない人にデータを書き換えさせない(画面を通らず直接叩かれる経路への備え)
  if (!(await currentUser())) redirect("/login");
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
  // ログインしていない人にデータを書き換えさせない(画面を通らず直接叩かれる経路への備え)
  if (!(await currentUser())) redirect("/login");
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
  // ログインしていない人にデータを書き換えさせない(画面を通らず直接叩かれる経路への備え)
  if (!(await currentUser())) redirect("/login");
  const id = Number(formData.get("deepdive_id"));
  must(await getSupabase().from("deepdive_items").delete().eq("id", id).select("id"));
  revalidatePath("/deepdive-list");
}

/**
 * 3-3: 検索で出てきた候補を、この行の仕入先として採用する。
 *
 * 自動検索(「仕入れ候補を探す」)は入力済みの値を書き換えないが、
 * ここは利用者がその候補を選んだ操作なので、単価と仕入先URLを**上書きする**。
 */
async function pickCandidate(formData: FormData) {
  "use server";
  // ログインしていない人にデータを書き換えさせない(画面を通らず直接叩かれる経路への備え)
  if (!(await currentUser())) redirect("/login");
  const deepdiveId = Number(formData.get("deepdive_id"));
  const candidateId = Number(formData.get("candidate_id"));
  if (!deepdiveId || !candidateId) return;

  const sb = getSupabase();
  const cand = must(
    await sb
      .from("sourcing_candidates")
      .select("id, product_group_id, source_platform, url, price_cny")
      .eq("id", candidateId)
      .single()
  ) as { id: number; product_group_id: number; source_platform: string; url: string; price_cny: number | null };

  const patch: Record<string, unknown> = {
    source_platform: cand.source_platform,
    source_url: cand.url,
  };
  // 価格が読めなかった候補(1688の検索リンクなど)は、単価まで消してしまわない
  if (cand.price_cny !== null) patch.unit_cost_cny = cand.price_cny;
  must(await sb.from("deepdive_items").update(patch).eq("id", deepdiveId).select("id"));

  // 採用の印はその商品につき1件だけにする
  must(
    await sb
      .from("sourcing_candidates")
      .update({ is_picked: false })
      .eq("product_group_id", cand.product_group_id)
      .select("id")
  );
  must(await sb.from("sourcing_candidates").update({ is_picked: true }).eq("id", candidateId).select("id"));
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

// ---------------------------------------------------------------- 3-3 仕入れ候補

const MODE_LABEL: Record<string, string> = {
  title: "タイトル検索",
  image: "画像検索",
  link: "検索リンク",
};

/** 候補1件のカード。押せば仕入先としてこの行に入る */
function CandidateCard({ c, deepdiveId }: { c: SourcingCandidateRow; deepdiveId: number }) {
  return (
    <div className="cand" data-picked={c.is_picked || undefined}>
      {c.image_url ? (
        <img className="cand-img" src={c.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="cand-img" />
      )}
      <div className="cand-body">
        <a className="cand-title" href={c.url} target="_blank" rel="noreferrer" title={c.title}>
          {c.title}
          <IconExternal size={11} />
        </a>
        <div className="cand-meta">
          <span className="cand-price">
            {c.price_cny !== null ? `${c.price_cny}元` : "価格不明"}
            {c.price_jpy !== null && (
              <span className="hint"> (¥{Math.round(c.price_jpy).toLocaleString()})</span>
            )}
          </span>
          {/* 一致度はタイトル検索にしか意味がない。
              画像検索は「名前は違うが見た目が同じ」商品を拾うのが値打ちなので、
              一致度が低いことは候補が悪いことを意味しない。
              それでも数字を出すと、良い候補が悪く見えてしまうため出さない。 */}
          {c.search_mode === "title" && c.match_score !== null && (
            <span
              className={`pill ${c.match_score >= 60 ? "pill-good" : c.match_score >= 30 ? "pill-info" : "pill-mute"}`}
              title="元の商品タイトルとどれくらい合っているか"
            >
              一致 {Math.round(c.match_score)}%
            </span>
          )}
          <span className="pill pill-mute">
            {c.search_mode === "image" ? <IconImage size={10} /> : <IconSearch size={10} />}
            {MODE_LABEL[c.search_mode] ?? c.search_mode}
          </span>
          {/* どこから来た候補かは、価格の桁が違うので必ず見せる(元 と 円) */}
          {c.source_platform === "1688" && <span className="pill pill-info">1688</span>}
          {/* 複数の写真から見つかった候補は、それだけ確からしい。いちばん先に出す */}
          {(c.photo_hits ?? 0) > 1 && (
            <span className="pill pill-good" title="複数の写真から同じ商品に行き着きました">
              写真{c.photo_hits}枚一致
            </span>
          )}
          {/* 1688 の店の信用度。AliExpress には無い情報なので、あるときだけ出す */}
          {c.repeat_rate !== null && c.repeat_rate !== undefined && (
            <span
              className={`pill ${c.repeat_rate >= 20 ? "pill-good" : "pill-mute"}`}
              title="この店で買った人が、また買っている割合(回头率)"
            >
              リピート {c.repeat_rate}%
            </span>
          )}
          {/* 1688 の店舗バッジ。厳選工場や実力商家は、それだけで選ぶ理由になる */}
          {c.badges?.slice(0, 2).map((b) => (
            <span key={b} className="pill pill-info" title="1688の店舗バッジ">
              {b}
            </span>
          ))}
          {c.orders_count !== null && (
            <span className="hint">
              {c.source_platform === "1688" ? "月販" : ""}
              {c.orders_count.toLocaleString()}
              {c.source_platform === "1688" ? "" : "点販売"}
            </span>
          )}
          {c.rating !== null && (
            <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <IconStar size={10} />
              {c.rating}
            </span>
          )}
          {c.is_ad && (
            <span className="pill pill-warn" title="検索順位ではなく広告枠で上に出ている商品です">
              広告
            </span>
          )}
        </div>
      </div>
      <form action={pickCandidate} className="cand-action">
        <input type="hidden" name="deepdive_id" value={deepdiveId} />
        <input type="hidden" name="candidate_id" value={c.id} />
        <button type="submit" className={c.is_picked ? "btn btn-ghost btn-sm" : "btn btn-dark btn-sm"}>
          {c.is_picked ? <IconCheck size={12} /> : <IconCart size={12} />}
          {c.is_picked ? "採用中" : "採用"}
        </button>
      </form>
    </div>
  );
}

/**
 * 1688Japan との接続状態。
 *
 * 1688 の候補はこの接続ひとつに乗っているので、切れていることに
 * 気づかないまま「候補が出ない」と悩む事態を防ぐ。
 * ここは**相手に問い合わせない**(記録しておいた結果を読むだけ)ので、
 * 画面を開くたびに通信が増えることはない。
 */
function Session1688Panel() {
  const status = readStatus();
  const line = statusLine(status);
  const tone =
    line.tone === "ok" ? "note-ok" : line.tone === "warn" ? "note-info" : "note-error";
  const Icon = line.tone === "ok" ? IconCheck : IconAlert;

  return (
    <div className={`note ${tone}`} style={{ marginBottom: 18 }}>
      <Icon size={15} />
      <span>
        <strong>1688 仕入れ候補の接続</strong> — {line.text}
        {line.tone !== "ok" && (
          <>
            <br />
            サーバーで <code>npm run login:1688jp</code> を実行し、開いた画面で確認コードを入れると復旧します。
            それまでは AliExpress の候補と、1688 の検索リンクだけが出ます。
          </>
        )}
      </span>
    </div>
  );
}

/** 探し方ごとのまとまり。先頭6件を出し、残りは畳んでおく */
function CandidateGroup({
  label,
  note,
  icon,
  list,
  deepdiveId,
  /** 画像検索など、開いたままだと邪魔なグループは閉じた状態から始める */
  defaultOpen = true,
}: {
  label: string;
  /** 並び順の根拠。何を見て判断すればよいかが分からないと候補は使えない */
  note?: string;
  icon: React.ReactNode;
  list: SourcingCandidateRow[];
  deepdiveId: number;
  defaultOpen?: boolean;
}) {
  if (!list.length) return null;
  const top = list.slice(0, 6);
  const rest = list.slice(6);
  return (
    <details className="cand-group" {...(defaultOpen ? { open: true } : {})}>
      <summary className="cand-group-head">
        {icon}
        {label}
        <span className="badge badge-muted">{list.length}件</span>
        {note && <span className="hint" style={{ fontWeight: 400 }}>{note}</span>}
      </summary>
      <div className="cand-grid">
        {top.map((c) => (
          <CandidateCard key={c.id} c={c} deepdiveId={deepdiveId} />
        ))}
      </div>
      {rest.length > 0 && (
        <details className="cand-more">
          <summary>残り{rest.length}件を見る</summary>
          <div className="cand-grid">
            {rest.map((c) => (
              <CandidateCard key={c.id} c={c} deepdiveId={deepdiveId} />
            ))}
          </div>
        </details>
      )}
    </details>
  );
}

/**
 * 仕入れ候補の一覧。
 *
 * タイトル検索と画像検索は**分けて出す**。
 * 画像検索は「見た目は同じだがタイトルが全然違う商品」を拾うのが値打ちで、
 * 一致度で一緒に並べると下に沈んで見えなくなるため。
 *
 * 候補の画像グリッドは注文作業の邪魔になるので、既定では折りたたんでおく。
 * 採用済みがあれば、その1件だけ常にコンパクト表示する。
 */
function SourcingSection({
  item,
  candidates,
}: {
  item: DeepdiveComputed;
  candidates: SourcingCandidateRow[];
}) {
  // 仕入元ごとに分ける。1688 は元建て・AliExpress は円建てで、
  // 店の信用度の出し方も違うので、混ぜて並べると見比べられない。
  const cn = (c: SourcingCandidateRow) => c.source_platform === "1688";
  const aliTitle = candidates.filter((c) => c.search_mode === "title" && !cn(c));
  const aliImage = candidates.filter((c) => c.search_mode === "image" && !cn(c));
  const cnTitle = candidates.filter((c) => c.search_mode === "title" && cn(c));
  const cnImage = candidates.filter((c) => c.search_mode === "image" && cn(c));
  const links = candidates.filter((c) => c.search_mode === "link");
  const products = aliTitle.length + aliImage.length + cnTitle.length + cnImage.length;
  const fetchedAt = candidates[0]?.fetched_at ?? null;
  // 見出しに出す検索語。1688 は中国語、AliExpress は日本語なので両方出す
  const zhQuery = cnTitle[0]?.query ?? null;
  const jaQuery = aliTitle[0]?.query ?? null;
  const picked = candidates.find((c) => c.is_picked) ?? null;
  const imageCount = aliImage.length + cnImage.length;

  return (
    <div className="sourcing">
      {/* 採用済みは注文作業で常に見たいので、折りたたみの外に出す */}
      {picked && (
        <div className="sourcing-picked">
          {picked.image_url ? (
            <img
              className="cand-img cand-img-sm"
              src={picked.image_url}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="cand-img cand-img-sm" />
          )}
          <div className="sourcing-picked-body">
            <span className="pill pill-good">
              <IconCheck size={10} /> 採用中
            </span>
            <a className="cand-title" href={picked.url} target="_blank" rel="noreferrer" title={picked.title}>
              {picked.title}
              <IconExternal size={11} />
            </a>
            <span className="cand-meta">
              <span className="cand-price">
                {picked.price_cny !== null ? `${picked.price_cny}元` : "価格不明"}
                {picked.price_jpy !== null && (
                  <span className="hint"> (¥{Math.round(picked.price_jpy).toLocaleString()})</span>
                )}
              </span>
              {picked.source_platform === "1688" && <span className="pill pill-info">1688</span>}
            </span>
          </div>
        </div>
      )}

      {products > 0 ? (
        <details className="sourcing-fold">
          <summary className="sourcing-head">
            <IconGlobe size={14} />
            仕入れ候補
            <span className="badge badge-muted">{products}件</span>
            {imageCount > 0 && (
              <span className="badge badge-muted">画像検索 {imageCount}件</span>
            )}
            {zhQuery && <span className="hint">1688「{zhQuery}」</span>}
            {jaQuery && <span className="hint">AliExpress「{jaQuery}」</span>}
            {fetchedAt && <span className="hint">取得 {fetchedAt.slice(0, 16)}</span>}
            <span className="sourcing-fold-hint hint">クリックで開閉（画像はここに畳んでいます）</span>
          </summary>

          <div className="sourcing-body">
            {/* 1688 は卸売なので、同じ商品でも AliExpress(小売)より桁が1つ安いことが多い。
                中国輸入の原価計算に使うのはこちらなので、先に出す。 */}
            <CandidateGroup
              label="1688 キーワード検索"
              note="1688Japan 経由。価格は元(CNY)・卸売価格です"
              icon={<IconSearch size={12} />}
              list={cnTitle}
              deepdiveId={item.deepdive_id}
            />
            <CandidateGroup
              label="1688 画像検索"
              note="複数の写真から見つかった順。価格は元(CNY)・卸売価格です"
              icon={<IconImage size={12} />}
              list={cnImage}
              deepdiveId={item.deepdive_id}
              defaultOpen={false}
            />
            <CandidateGroup
              label="AliExpress タイトル検索"
              note="タイトルの一致度が高い順。小売価格なので1688より高めです"
              icon={<IconSearch size={12} />}
              list={aliTitle}
              deepdiveId={item.deepdive_id}
            />
            <CandidateGroup
              label="AliExpress 画像検索"
              note="見た目が近い順。小売価格なので1688より高めです"
              icon={<IconImage size={12} />}
              list={aliImage}
              deepdiveId={item.deepdive_id}
              defaultOpen={false}
            />
          </div>
        </details>
      ) : (
        <>
          <div className="sourcing-head">
            <IconGlobe size={14} />
            仕入れ候補
            <span className="badge badge-muted">0件</span>
          </div>
          <p className="hint" style={{ margin: "2px 0 8px" }}>
            まだ候補がありません。下のボタンでAliExpressを検索してください。
          </p>
        </>
      )}

      {links.length > 0 && (
        <div className="cand-links">
          {links.map((c) => (
            <a key={c.id} className="link" href={c.url} target="_blank" rel="noreferrer">
              {c.title}
              <IconExternal size={11} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default async function DeepdiveListPage() {
  let items: DeepdiveComputed[] = [];
  let settings: Settings | null = null;
  let candidates = new Map<number, SourcingCandidateRow[]>();
  let error: string | null = null;
  try {
    items = await getDeepdiveListV2();
    settings = await getSettings();
    // 3-3 の候補は1回でまとめて読む(行ごとに問い合わせない)
    candidates = await getSourcingCandidates(items.map((i) => i.product_group_id));
  } catch (e) {
    error = String(e);
  }

  const profitable = items.filter((i) => (i.profit_per_unit ?? -1) > 0).length;
  const waiting = items.filter((i) => i.profit_per_unit === null).length;

  return (
    <div className="page-wide">
      <div className="page-head">
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

      <Session1688Panel />

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
                  item.representative_listing_url ? (
                    <a
                      className="thumb-link"
                      href={item.representative_listing_url}
                      target="_blank"
                      rel="noreferrer"
                      title="メルカリの商品ページを開く"
                    >
                      <img className="thumb" src={item.representative_image_url} alt="" />
                    </a>
                  ) : (
                    <img className="thumb" src={item.representative_image_url} alt="" />
                  )
                ) : (
                  <div className="thumb" />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="item-title">
                    {item.representative_listing_url ? (
                      <a
                        href={item.representative_listing_url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "inherit", textDecoration: "none" }}
                      >
                        {item.representative_title}
                      </a>
                    ) : (
                      item.representative_title
                    )}
                  </div>
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

              <SourcingSection item={item} candidates={candidates.get(item.product_group_id) ?? []} />

              <div style={{ marginTop: 12 }}>
                <ScrapeRunner
                  kind="sourcing"
                  payload={{ product_group_id: item.product_group_id, apply: true }}
                  buttonLabel="仕入れ候補を探す"
                  title="仕入れ候補の自動検索(AliExpress・サーバー側)"
                  description="商品タイトルと商品画像でAliExpressを検索し、候補を上に並べます。単価が未入力の場合だけ、最有力候補を自動で反映します(入力済みの値は変えません)。"
                  withSourcingOptions
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
