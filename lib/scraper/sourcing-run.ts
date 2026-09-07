/**
 * 発注仕様書 3-3 の実行本体。
 *
 * 「鉄板商品(product_groups)を1件受け取って、AliExpress/1688 の仕入れ候補を
 *   集めて sourcing_candidates に保存し、必要なら深掘りリストに反映する」までを
 * ここに1本化している。
 *
 * 呼び出し口が3つある(画面のAPI・常駐ワーカー・CLI)ので、
 * 同じ処理を3か所に書かないためにこのファイルへ寄せている。
 *   app/api/scrape/route.ts  … 画面のボタン(その場で実行)
 *   scripts/worker.ts        … jobsテーブル経由の常駐ワーカー
 *   scripts/scrape-sourcing.ts … コマンドライン
 */
import { getSupabase, must } from "../supabase";
import { getSettings } from "../db";
import {
  Alibaba1688Sourcing,
  AliExpressSourcing,
  toSearchQuery,
} from "./sourcing";
import type { SourcingCandidate } from "./types";

export type SourcingPhase = "title" | "image" | "save";

export type SourcingRunOptions = {
  productGroupId: number;
  /** 使う探し方。既定はタイトル検索と画像検索の両方 */
  modes?: ("title" | "image")[];
  /** 探し方ごとに拾う件数の上限 */
  limit?: number;
  /** 最有力候補を深掘りリストに反映するか(単価が未入力の行にだけ入れる) */
  apply?: boolean;
  /** ページを開く間隔(ミリ秒) */
  intervalMs?: number;
  log?: (m: string) => void;
  onPhase?: (p: { phase: SourcingPhase; done?: number; total?: number; label?: string }) => void;
};

export type SourcingRunResult = {
  product_group_id: number;
  title: string;
  query: string;
  /** 保存した候補の件数 */
  candidates: number;
  by_mode: { title: number; image: number; link: number };
  best: { title: string; price_cny: number | null; url: string; match_score: number | null } | null;
  /** 深掘りリストに反映した行数 */
  applied: number;
  /** 画像検索をしなかった/できなかった理由。行われた場合は null */
  image_skipped: string | null;
};

type ProductGroup = {
  id: number;
  representative_title: string;
  representative_image_url: string | null;
};

/** sourcing_candidates がまだ無い(schema.sql 未適用)ことが原因のエラーか */
export function isMissingSourcingTable(e: unknown): boolean {
  const s = String(e instanceof Error ? e.message : e);
  return /sourcing_candidates/.test(s) && /does not exist|schema cache|42P01/i.test(s);
}

const SCHEMA_HINT =
  "sourcing_candidates テーブルがありません。supabase/schema.sql を Supabase の SQL Editor に貼って Run してください(または npm run db:push)。";

// ---------------------------------------------------------------- 並べ替え

/**
 * 候補を1本の並びにまとめる。
 *
 *  ・同じ商品(サイト側の商品ID)がタイトル検索と画像検索の両方で出ることがあるので、
 *    一致度の高いほうを残して1件にする。
 *  ・並び順は「一致度が高い順 → 安い順」。価格が読めなかったものは後ろに回す
 *    (原価計算に使えないため)。
 *  ・1688 の検索URL行は商品ではないので、常に最後に置く。
 */
export function rankCandidates(candidates: SourcingCandidate[]): SourcingCandidate[] {
  const byKey = new Map<string, SourcingCandidate>();
  const links: SourcingCandidate[] = [];

  for (const c of candidates) {
    if (c.search_mode === "link") {
      links.push(c);
      continue;
    }
    const key = `${c.source_platform}:${c.external_id ?? c.url}`;
    const prev = byKey.get(key);
    if (!prev || (c.match_score ?? 0) > (prev.match_score ?? 0)) byKey.set(key, c);
  }

  const items = [...byKey.values()].sort((a, b) => {
    const ap = a.price_cny === null ? 1 : 0;
    const bp = b.price_cny === null ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const as = a.match_score ?? 0;
    const bs = b.match_score ?? 0;
    if (as !== bs) return bs - as;
    return (a.price_cny ?? Infinity) - (b.price_cny ?? Infinity);
  });

  return [...items, ...links];
}

/**
 * 深掘りリストに自動で入れる「最有力候補」を選ぶ。
 *
 * 一致度が高いものの中から**いちばん安いもの**を選ぶ。
 * 安いだけで選ぶと全然違う商品を掴むし、一致度だけで選ぶと利益が出ないため。
 * 一致度が十分な候補が無いときは、上位5件から安いものを選ぶ。
 */
export function pickBest(ranked: SourcingCandidate[]): SourcingCandidate | null {
  const priced = ranked.filter((c) => c.search_mode !== "link" && c.price_cny !== null);
  if (!priced.length) return null;
  const confident = priced.filter((c) => (c.match_score ?? 0) >= 40);
  const pool = confident.length ? confident : priced.slice(0, 5);
  return [...pool].sort((a, b) => (a.price_cny ?? Infinity) - (b.price_cny ?? Infinity))[0] ?? null;
}

// ---------------------------------------------------------------- 保存

/**
 * その商品の候補を入れ替える(前回の結果は消す)。
 *
 * 履歴を貯めても古い価格が混ざるだけで判断の役に立たないため、
 * 「最後に検索した結果」だけを持つ。ただし、利用者が採用した候補の印
 * (is_picked)は同じURLの候補が再び見つかったときに引き継ぐ。
 */
export async function saveCandidates(
  productGroupId: number,
  ranked: SourcingCandidate[]
): Promise<number> {
  const sb = getSupabase();

  const prev = (must(
    await sb
      .from("sourcing_candidates")
      .select("url, is_picked")
      .eq("product_group_id", productGroupId)
  ) ?? []) as { url: string; is_picked: boolean | null }[];
  const pickedUrls = new Set(prev.filter((p) => p.is_picked).map((p) => p.url));

  must(
    await sb.from("sourcing_candidates").delete().eq("product_group_id", productGroupId).select("id")
  );
  if (!ranked.length) return 0;

  const rows = ranked.map((c, i) => ({
    product_group_id: productGroupId,
    source_platform: c.source_platform,
    search_mode: c.search_mode,
    query: c.query,
    external_id: c.external_id,
    title: c.title,
    price: c.price,
    currency: c.currency,
    price_jpy: c.price_jpy,
    price_cny: c.price_cny,
    url: c.url,
    image_url: c.image_url,
    min_order_qty: c.min_order_qty,
    orders_count: c.orders_count,
    rating: c.rating,
    is_ad: c.is_ad,
    match_score: c.match_score,
    rank: i + 1,
    is_picked: pickedUrls.has(c.url),
  }));

  // 同じURLが同じ探し方で2回出ることは無いが、念のため重複は落としておく
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = `${r.source_platform}|${r.search_mode}|${r.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  must(await sb.from("sourcing_candidates").insert(unique).select("id"));
  return unique.length;
}

/**
 * 深掘りリストへ最有力候補を反映する。
 *
 * **すでに入力されている値は上書きしない**。手で調べて入れた単価を
 * 自動検索の結果で消してしまうと、気づかないうちに利益計算が変わるため。
 * 上書きしたいときは、画面の候補一覧から「採用」を押してもらう。
 */
export async function applyBest(
  productGroupId: number,
  best: SourcingCandidate
): Promise<number> {
  const sb = getSupabase();
  const items = (must(
    await sb
      .from("deepdive_items")
      .select("id, unit_cost_cny, source_url")
      .eq("product_group_id", productGroupId)
  ) ?? []) as { id: number; unit_cost_cny: number | null; source_url: string | null }[];

  let applied = 0;
  for (const it of items) {
    const patch: Record<string, unknown> = {};
    if (it.unit_cost_cny === null && best.price_cny !== null) patch.unit_cost_cny = best.price_cny;
    if (!it.source_url) {
      patch.source_url = best.url;
      patch.source_platform = best.source_platform;
    }
    if (!Object.keys(patch).length) continue;
    must(await sb.from("deepdive_items").update(patch).eq("id", it.id).select("id"));
    applied++;
  }
  return applied;
}

// ---------------------------------------------------------------- 実行

/**
 * 1商品ぶんの仕入れ候補を集める。
 *
 * 画像検索はタイトル検索より当たり外れが大きい(同じ形の別商品を拾う)ので、
 * どちらの探し方で見つけたかを候補ごとに残し、画面で見分けられるようにしている。
 */
export async function runSourcing(options: SourcingRunOptions): Promise<SourcingRunResult> {
  const {
    productGroupId,
    modes = ["title", "image"],
    limit = 12,
    apply = false,
    intervalMs = 3000,
    log = () => {},
    onPhase = () => {},
  } = options;

  const sb = getSupabase();
  const group = must(
    await sb
      .from("product_groups")
      .select("id, representative_title, representative_image_url")
      .eq("id", productGroupId)
      .maybeSingle()
  ) as ProductGroup | null;
  if (!group) {
    throw new Error(`商品グループ #${productGroupId} が見つかりません(セラー深掘りで作られる行です)。`);
  }

  const settings = await getSettings();
  const rate = settings.exchange_rate_jpy_per_cny;
  const query = toSearchQuery(group.representative_title);

  log(`対象: ${group.representative_title}`);
  log(`検索語: 「${query}」 / 為替: ${rate} 円/元`);

  const collected: SourcingCandidate[] = [];
  let imageSkipped: string | null = null;

  const ae = new AliExpressSourcing(rate, { minIntervalMs: intervalMs, log });
  try {
    await ae.start();

    if (modes.includes("title")) {
      onPhase({ phase: "title", label: query });
      const found = await ae.searchCandidates(group.representative_title, limit);
      collected.push(...found);
    }

    if (modes.includes("image")) {
      if (!group.representative_image_url) {
        imageSkipped = "この商品には画像が保存されていません(セラー深掘りを取り直すと入ります)。";
        log(`  画像検索は行いません: ${imageSkipped}`);
      } else {
        onPhase({ phase: "image" });
        const before = collected.length;
        const found = await ae.searchByImage(
          group.representative_image_url,
          limit,
          group.representative_title
        );
        collected.push(...found);
        if (collected.length === before) {
          imageSkipped = "画像検索から候補を取得できませんでした。";
        }
      }
    }
  } finally {
    await ae.close();
  }

  // 1688 は検索そのものができないので、人が開くためのリンクを添える
  const alibaba = new Alibaba1688Sourcing();
  collected.push(...(await alibaba.searchCandidates(group.representative_title)));
  if (group.representative_image_url) {
    collected.push(...(await alibaba.searchByImage(group.representative_image_url)));
  }

  onPhase({ phase: "save" });
  const ranked = rankCandidates(collected);
  let saved = 0;
  try {
    saved = await saveCandidates(productGroupId, ranked);
  } catch (e) {
    if (isMissingSourcingTable(e)) throw new Error(SCHEMA_HINT);
    throw e;
  }

  const by_mode = {
    title: ranked.filter((c) => c.search_mode === "title").length,
    image: ranked.filter((c) => c.search_mode === "image").length,
    link: ranked.filter((c) => c.search_mode === "link").length,
  };
  log("");
  log(`候補を${saved}件保存しました(タイトル検索${by_mode.title}件 / 画像検索${by_mode.image}件 / 1688リンク${by_mode.link}件)`);

  const best = pickBest(ranked);
  if (best) {
    log(
      `最有力: ${best.price_cny !== null ? `${best.price_cny}元` : "価格不明"}` +
        ` / 一致度${best.match_score ?? 0}% / ${best.title.slice(0, 50)}`
    );
    log(`  ${best.url}`);
  } else {
    log("価格を読み取れた候補がありませんでした。画面の一覧から手で選んでください。");
  }

  let applied = 0;
  if (apply && best) {
    applied = await applyBest(productGroupId, best);
    log(
      applied > 0
        ? `深掘りリスト${applied}件に、単価と仕入先URLを入れました(すでに入力済みの値は変えていません)。`
        : "深掘りリストは、すでに入力済みなので変更していません。上書きするときは候補の「採用」を押してください。"
    );
  }

  return {
    product_group_id: productGroupId,
    title: group.representative_title,
    query,
    candidates: saved,
    by_mode,
    best: best
      ? { title: best.title, price_cny: best.price_cny, url: best.url, match_score: best.match_score }
      : null,
    applied,
    image_skipped: imageSkipped,
  };
}
