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
  mercariPhotoUrls,
  toSearchQuery,
} from "./sourcing";
import { Missing1688JpSession, Sourcing1688Jp } from "./sourcing-1688jp";
import { toChineseQuery } from "./zh-query";
import type { SourcingCandidate } from "./types";

export type SourcingPhase = "title" | "image" | "save";

export type SourcingRunOptions = {
  productGroupId: number;
  /** 使う探し方。既定はタイトル検索と画像検索の両方 */
  modes?: ("title" | "image")[];
  /** 探し方ごとに拾う件数の上限 */
  limit?: number;
  /**
   * 画像検索で使う写真の枚数(既定3枚)。
   *
   * メルカリの1枚目は文字入れや箱の写真のことが多く、それ1枚では当たらない。
   * 増やすほど当たる見込みは上がるが、1枚あたり15〜25秒かかる。
   */
  imageCount?: number;
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
 * **探し方ごとに別々に並べる。** 画面でもタイトル検索と画像検索は分けて出すので、
 * 混ぜて並べる必要がないうえ、混ぜると次の2つが壊れる。
 *
 *  1. 画像検索の並び順が失われる
 *     画像検索はサイト側が**見た目の近い順**に返してくる。これがいちばん確かな
 *     手がかりなのに、文字列の一致度で並べ直すと、いちばん似ている商品が
 *     下に沈んでしまう。画像検索は source_rank(サイトが返した順)の順に並べる。
 *  2. 両方で見つかった商品が片方から消える
 *     同じ商品がタイトル検索でも画像検索でも出るのは「当たり」の強い証拠なので、
 *     どちらの一覧にも残す(重複をまとめるのは同じ探し方の中だけ)。
 *
 * 1688 の検索URL行は商品ではないので、常に最後に置く。
 */
export function rankCandidates(candidates: SourcingCandidate[]): SourcingCandidate[] {
  const links: SourcingCandidate[] = [];
  const byMode = new Map<string, Map<string, SourcingCandidate>>();

  for (const c of candidates) {
    if (c.search_mode === "link") {
      links.push(c);
      continue;
    }
    // 仕入元ごとに分ける。1688 と AliExpress は値段の桁も並びの根拠も違うので、
    // 混ぜて並べると見比べられなくなる(画面でも別々に出している)
    const group = `${c.source_platform}|${c.search_mode}`;
    const inMode = byMode.get(group) ?? new Map<string, SourcingCandidate>();
    byMode.set(group, inMode);
    const key = `${c.source_platform}:${c.external_id ?? c.url}`;
    const prev = inMode.get(key);
    // 同じ探し方で同じ商品が二度出たら、上に出ていたほうを残す
    if (!prev || (c.source_rank ?? 999) < (prev.source_rank ?? 999)) inMode.set(key, c);
  }

  /** タイトル検索: 一致度が高い順 → 安い順。価格が読めないものは後ろ */
  const byRelevance = (a: SourcingCandidate, b: SourcingCandidate) => {
    const ap = a.price_cny === null ? 1 : 0;
    const bp = b.price_cny === null ? 1 : 0;
    if (ap !== bp) return ap - bp;
    const as = a.match_score ?? 0;
    const bs = b.match_score ?? 0;
    if (as !== bs) return bs - as;
    return (a.price_cny ?? Infinity) - (b.price_cny ?? Infinity);
  };

  /** 画像検索: サイトが返してきた順(=見た目の近い順)をそのまま守る */
  const bySourceOrder = (a: SourcingCandidate, b: SourcingCandidate) =>
    (a.source_rank ?? 999) - (b.source_rank ?? 999);

  const take = (key: string) => [...(byMode.get(key)?.values() ?? [])];

  // 一致度が意味を持つのは AliExpress のタイトル検索だけ。
  // 1688 は日本語に訳されたタイトルが返るので、文字列の比較には使えない
  // (相手のAPIが返した順=関連度の順をそのまま守る)。
  const aeTitle = take("aliexpress|title").sort(byRelevance);
  const aeImage = take("aliexpress|image").sort(bySourceOrder);
  const cnTitle = take("1688|title").sort(bySourceOrder);
  const cnImage = take("1688|image").sort(bySourceOrder);

  return [...aeTitle, ...aeImage, ...cnTitle, ...cnImage, ...links];
}

/**
 * 深掘りリストに自動で入れる「最有力候補」を選ぶ。
 *
 * 安いだけで選ぶと全然違う商品を掴み、一致度だけで選ぶと利益が出ない。
 * そこで「合っていると言える候補の中で、いちばん安いもの」を選ぶ。
 *
 * **一致度はタイトル検索にしか使えない。** 画像検索は「名前は違うが見た目が同じ」
 * 商品を拾うのが値打ちなので、一致度が低いことは候補が悪いことを意味しない。
 * 裏を返すと、画像検索の結果は一致度で確かめられないということでもある。
 * 自動で原価に入れる値なので、次の順に慎重に選ぶ。
 *
 *   1. タイトル検索で一致度40%以上 → その中でいちばん安いもの
 *   2. 1が無ければ、タイトル検索の上位5件から安いもの
 *   3. タイトル検索が空のときだけ、画像検索の**上位3件**から安いもの
 *      (見た目がいちばん近い範囲に絞る。ここから下は当てにならない)
 */
export function pickBest(ranked: SourcingCandidate[]): SourcingCandidate | null {
  const cheapest = (xs: SourcingCandidate[]) =>
    [...xs].sort((a, b) => (a.price_cny ?? Infinity) - (b.price_cny ?? Infinity))[0] ?? null;
  const priced = (platform: string, mode: string) =>
    ranked.filter(
      (c) => c.source_platform === platform && c.search_mode === mode && c.price_cny !== null
    );

  // ① 1688 の画像検索で、複数の写真から同じ商品に行き着いたもの。
  //    「どの角度でも一致した」がいちばん確かな手がかりで、
  //    1688 は卸売なので原価計算にもそのまま使える。
  const cnImage = priced("1688", "image");
  const consensus = cnImage.filter((c) => (c.photo_hits ?? 1) > 1);
  if (consensus.length) return cheapest(consensus);

  // ② 1688 の画像検索の上位3件(見た目がいちばん近い範囲に絞る)
  if (cnImage.length) return cheapest(cnImage.slice(0, 3));

  // ③ 1688 のキーワード検索の上位5件
  const cnTitle = priced("1688", "title");
  if (cnTitle.length) return cheapest(cnTitle.slice(0, 5));

  // ④ 1688 が使えないとき(セッション切れなど)だけ AliExpress へ。
  //    こちらは小売なので、同じ商品でも1688より高く出る
  const aeTitle = priced("aliexpress", "title");
  const confident = aeTitle.filter((c) => (c.match_score ?? 0) >= 40);
  if (confident.length) return cheapest(confident);
  if (aeTitle.length) return cheapest(aeTitle.slice(0, 5));

  const aeImage = priced("aliexpress", "image").slice(0, 3);
  return aeImage.length ? cheapest(aeImage) : null;
}

// ---------------------------------------------------------------- 保存

/**
 * その商品の候補を入れ替える(前回の結果は消す)。
 *
 * 履歴を貯めても古い価格が混ざるだけで判断の役に立たないため、
 * 「最後に検索した結果」だけを持つ。ただし、利用者が採用した候補の印
 * (is_picked)は同じURLの候補が再び見つかったときに引き継ぐ。
 */
/**
 * 1688 用の列が無いDBだと、リピート率や店舗バッジは保存できない。
 * 何度も出すとログが埋まるので、プロセスごとに1回だけ知らせる。
 */
let warnedMissingColumns = false;
function warnMissingColumns(): void {
  if (warnedMissingColumns) return;
  warnedMissingColumns = true;
  console.warn(
    "  ※ リピート率・店舗バッジ・写真一致数は保存していません" +
      "(sourcing_candidates に列がありません)。supabase/schema.sql を適用すると保存されます。"
  );
}

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
    // 1688 からしか来ない項目。列が無い古いDBでも落ちないよう、
    // undefined ではなく null を入れておく(supabase-js は undefined を落とす)
    repeat_rate: c.repeat_rate ?? null,
    badges: c.badges ?? null,
    photo_hits: c.photo_hits ?? null,
    listed_at: c.listed_at ?? null,
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

  const res = await sb.from("sourcing_candidates").insert(unique).select("id");
  if (res.error && /repeat_rate|badges|photo_hits|listed_at/.test(res.error.message)) {
    // 1688 用の列がまだ無いDB。候補そのものは保存できたほうがよいので、
    // その列だけ落として入れ直す(schema.sql を適用すれば次から全部入る)。
    // 黙って捨てると「なぜリピート率が出ないのか」が分からなくなるので、1回だけ知らせる。
    warnMissingColumns();
    const trimmed = unique.map(({ repeat_rate, badges, photo_hits, listed_at, ...rest }) => rest);
    must(await sb.from("sourcing_candidates").insert(trimmed).select("id"));
    return trimmed.length;
  }
  must(res);
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
    imageCount = 5,
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

  // 1688 は中国語でしか当たらないので、先に検索語を用意する
  const zh = toChineseQuery(group.representative_title);
  if (zh.query) {
    log(
      `1688の検索語: 「${zh.query}」` +
        (zh.confident ? `(${zh.matched.join(" / ")})` : "(対訳表に無いため漢字をそのまま使用・要確認)")
    );
    if (zh.unmatched.length) log(`  訳せなかった語: ${zh.unmatched.join(" ")}`);
  } else {
    log("1688の検索語を作れませんでした(中国語に直せる語がタイトルにありません)。");
  }

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
        // 1枚目だけでは当たらないことが多いので、同じ出品の写真を順に試す
        const photos = mercariPhotoUrls(group.representative_image_url, imageCount);
        log(`  画像検索に使う写真: 最大${photos.length}枚`);
        const found = await ae.searchByImage(photos, limit, group.representative_title);
        collected.push(...found);
        if (collected.length === before) {
          imageSkipped = "画像検索から候補を取得できませんでした。";
        }
      }
    }
  } finally {
    await ae.close();
  }

  // ---------------------------------------------------------------- 1688
  //
  // 1688.com はすべての経路がログイン必須でサーバーからは開けない。
  // 代わりに 1688Japan(1688の日本公式総代理店)の会員ページ経由で取る。
  // ブラウザは使わず、保存したセッションでHTTPを叩くだけなので速い。
  //
  // セッションが無い/切れている場合は、ここで止めずに
  // 「人が開けば使える検索リンク」に切り替える(AliExpress の結果まで捨てない)。
  let cn1688Note: string | null = null;
  try {
    const jp = new Sourcing1688Jp({ limit, log });

    if (modes.includes("title")) {
      if (zh.query) {
        onPhase({ phase: "title", label: `1688 ${zh.query}` });
        collected.push(...(await jp.searchByKeyword(zh.query)));
      } else {
        log("  1688 キーワード検索は行いません(中国語に直せる語がありません)。");
      }
    }

    if (modes.includes("image") && group.representative_image_url) {
      onPhase({ phase: "image", label: "1688 画像検索" });
      const photos = mercariPhotoUrls(group.representative_image_url, imageCount);
      const merged = new Map<string, { c: SourcingCandidate; hits: number; best: number }>();
      let searched = 0;

      for (const [i, url] of photos.entries()) {
        const found = await jp.searchByPhoto(url, i + 1, photos.length);
        if (!found.length) continue;
        searched++;
        for (const c of found) {
          const key = c.external_id ?? c.url;
          const prev = merged.get(key);
          const rank = c.source_rank ?? 999;
          if (prev) {
            prev.hits++;
            if (rank < prev.best) {
              prev.best = rank;
              prev.c = c;
            }
          } else {
            merged.set(key, { c, hits: 1, best: rank });
          }
        }
      }

      if (searched) {
        // 複数の写真から出てきた商品を先頭に(角度を変えても同じ商品に行き着いた=確からしい)
        const ordered = [...merged.values()]
          .sort((a, b) => (b.hits !== a.hits ? b.hits - a.hits : a.best - b.best))
          .slice(0, limit)
          .map(({ c, hits }, idx) => ({ ...c, source_rank: idx + 1, photo_hits: hits }));
        const multi = ordered.filter((c) => (c.photo_hits ?? 1) > 1).length;
        log(
          `  1688 画像検索 まとめ: ${searched}枚から候補${ordered.length}件` +
            (multi ? `(うち${multi}件は複数の写真から一致)` : "")
        );
        collected.push(...ordered);
      }
    }
  } catch (e) {
    if (e instanceof Missing1688JpSession) {
      cn1688Note = e.message;
      log(`  1688: ${e.message}`);
    } else {
      cn1688Note = String(e instanceof Error ? e.message : e).slice(0, 200);
      log(`  1688: ${cn1688Note}`);
    }
  }

  // 1688 から商品を取れなかったときだけ、人が開くための検索リンクを添える。
  // 取れているときに出すと、候補の一覧に押せないだけの行が混ざって邪魔になる。
  if (!collected.some((c) => c.source_platform === "1688" && c.search_mode !== "link")) {
    const alibaba = new Alibaba1688Sourcing();
    collected.push(...(await alibaba.searchCandidates(group.representative_title)));
    if (group.representative_image_url) {
      collected.push(...(await alibaba.searchByImage([group.representative_image_url])));
    }
  }

  // 1688 は元建てでしか値が来ないので、共通設定の為替で円に直しておく
  // (画面は円で見比べるため。AliExpress 側は取得時に換算済み)
  for (const c of collected) {
    if (c.price_jpy === null && c.price_cny !== null && rate > 0) {
      c.price_jpy = Math.round(c.price_cny * rate);
    }
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
        // 一致度はタイトル検索にしか意味がない。画像検索では出さない
        (best.search_mode === "title" ? ` / 一致度${best.match_score ?? 0}%` : " / 画像検索から") +
        ` / ${best.title.slice(0, 50)}`
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
