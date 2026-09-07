/**
 * スクレイパーの取得結果を Supabase に投入する層。
 * scraper/import_csv.py の get_or_create_seller / INSERT OR IGNORE と同じ考え方。
 */
import { getSupabase, must } from "../supabase";
import type { ScrapedListing, ScrapedSeller } from "./types";

/** sellers を取得 or 作成して内部IDを返す */
export async function upsertSeller(s: ScrapedSeller): Promise<number> {
  const sb = getSupabase();
  const found = must(
    await sb
      .from("sellers")
      .select("id")
      .eq("platform", s.platform)
      .eq("seller_external_id", s.seller_external_id)
      .maybeSingle()
  ) as { id: number } | null;

  if (found) {
    // 名前や評価数は変わるので、取得できた分だけ更新する
    const patch: Record<string, unknown> = { seller_name: s.seller_name };
    if (s.rating !== null) patch.rating = s.rating;
    if (s.review_count !== null) patch.review_count = s.review_count;
    if (s.profile_url) patch.profile_url = s.profile_url;
    if (s.avatar_url) patch.avatar_url = s.avatar_url;
    must(await sb.from("sellers").update(patch).eq("id", found.id).select("id"));
    return found.id;
  }

  const created = must(
    await sb
      .from("sellers")
      .insert({
        platform: s.platform,
        seller_external_id: s.seller_external_id,
        seller_name: s.seller_name,
        rating: s.rating,
        review_count: s.review_count,
        profile_url: s.profile_url,
        avatar_url: s.avatar_url ?? null,
      })
      .select("id")
      .single()
  ) as { id: number };
  return created.id;
}

/** プロフィールページを実際に開いて取れた情報(mercari-seller.ts の SellerProfile と同じ形) */
type FetchedSeller = ScrapedSeller & {
  listing_count?: number | null;
  good_ratings?: number | null;
  bad_ratings?: number | null;
  registered_at?: string | null;
};

/**
 * そのセラーのプロフィールを実際に開いて取れたものかどうか。
 *
 * 検索結果からしか分かっていないセラーは、名前とIDしか持っていない。
 * プロフィールを開いた場合は必ず avatar_url を(取れなければ null として)持つので、
 * このキーの有無で区別できる。
 */
function isFetchedProfile(s: ScrapedSeller): s is FetchedSeller {
  return "avatar_url" in s;
}

export type SaveResult = { sellers: number; inserted: number; skipped: number };

/**
 * ScrapedListing[] を sellers / listings に投入する。
 * 既に同じ (platform, external_id) がある場合は無視する(import_csv.py と同じ挙動)。
 */
export async function saveListings(
  listings: ScrapedListing[],
  profiles: Map<string, ScrapedSeller> = new Map(),
  log: (m: string) => void = () => {}
): Promise<SaveResult> {
  const sb = getSupabase();

  // セラーを先にまとめて登録する(1人ずつだと出品数ぶん往復してしまう)
  const wanted = new Map<string, ScrapedSeller>();
  for (const l of listings) {
    if (wanted.has(l.seller_external_id)) continue;
    wanted.set(
      l.seller_external_id,
      profiles.get(l.seller_external_id) ?? {
        platform: l.platform,
        seller_external_id: l.seller_external_id,
        seller_name: l.seller_name,
        rating: null,
        review_count: null,
        profile_url: l.seller_external_id.startsWith("shops:")
          ? `https://jp.mercari.com/shops/profile/${l.seller_external_id.slice(6)}`
          : `https://jp.mercari.com/user/profile/${l.seller_external_id}`,
      }
    );
  }
  const sellerIds = await upsertSellers(wanted);
  log(`セラー: ${sellerIds.size}件を登録/更新`);

  if (!listings.length) return { sellers: sellerIds.size, inserted: 0, skipped: 0 };

  const rows = listings.map((l) => {
    // 検索経由で取れる追加情報(supabase/schema.sql で追加した列)。無ければ null のまま
    const ext = l as ScrapedListing & {
      is_new?: boolean | null;
      updated_at?: string | null;
      shipping_method_id?: string | null;
      is_shops?: boolean;
      matched_keyword?: string;
      ship_status?: string | null;
      ship_class?: string | null;
    };
    return {
      seller_id: sellerIds.get(l.seller_external_id)!,
      platform: l.platform,
      external_id: l.external_id,
      title: l.title,
      price: l.price,
      status: l.status,
      listed_at: l.listed_at ?? null,
      sold_at: l.sold_at ?? null,
      shipping_method: l.shipping_method ?? null,
      shipping_cost: l.shipping_cost ?? null,
      image_url: l.image_url ?? null,
      listing_url: l.listing_url ?? null,
      is_new: ext.is_new ?? null,
      updated_at: ext.updated_at ?? null,
      shipping_method_id: ext.shipping_method_id ?? null,
      is_shops: ext.is_shops ?? false,
      matched_keyword: ext.matched_keyword ?? null,
      ship_status: ext.ship_status ?? null,
      ship_class: ext.ship_class ?? null,
    };
  });

  // 100件ずつに分けて投入(1リクエストが大きくなりすぎないように)
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = must(
      await sb
        .from("listings")
        .upsert(chunk, { onConflict: "platform,external_id", ignoreDuplicates: true })
        .select("id")
    ) as { id: number }[] | null;
    inserted += res?.length ?? 0;
  }

  const result = { sellers: sellerIds.size, inserted, skipped: rows.length - inserted };
  log(`出品: ${result.inserted}件を新規登録(既存のためスキップ ${result.skipped}件)`);
  return result;
}

/**
 * 実送料を取りに行った出品について、既存行を更新する(3-2)。
 *
 * saveListings() は既存の (platform, external_id) を**無視する**(＝上書きしない)ため、
 * 2回目以降の深掘りで取れた実送料がそのままでは反映されない。
 * 実送料は「上位N件だけ後から取りに行く」性質の値なので、ここだけ明示的に更新する。
 *
 * ship_status が未設定/skip の出品(＝そもそも取りに行っていない)は触らない。
 * 以前に取れていた値を、今回の対象外だからといって消してしまわないため。
 */
export async function updateShipping(
  listings: {
    platform: string;
    external_id: string;
    shipping_cost?: number | null;
    shipping_method?: string | null;
    ship_status?: string | null;
    ship_class?: string | null;
  }[],
  log: (m: string) => void = () => {}
): Promise<number> {
  const targets = listings.filter((l) => l.ship_status && l.ship_status !== "skip");
  if (!targets.length) return 0;

  const sb = getSupabase();
  let updated = 0;
  for (const l of targets) {
    const res = must(
      await sb
        .from("listings")
        .update({
          shipping_cost: l.shipping_cost ?? null,
          shipping_method: l.shipping_method ?? null,
          ship_status: l.ship_status,
          ship_class: l.ship_class ?? null,
        })
        .eq("platform", l.platform)
        .eq("external_id", l.external_id)
        .select("id")
    ) as { id: number }[] | null;
    updated += res?.length ?? 0;
  }
  log(`実送料: ${updated}件を更新`);
  return updated;
}

/** searches テーブルに検索履歴を1行作り、そのIDを返す */
export async function createSearch(keywords: string, aruaruWords: string[]): Promise<number> {
  const row = must(
    await getSupabase()
      .from("searches")
      .insert({
        keywords,
        aruaru_words: aruaruWords.length ? aruaruWords.join(",") : null,
        platform: "mercari",
      })
      .select("id")
      .single()
  ) as { id: number };
  return row.id;
}

/** platform+external_id から内部の seller_id を引く */
export async function findSellerId(platform: string, externalId: string): Promise<number | null> {
  const row = must(
    await getSupabase()
      .from("sellers")
      .select("id")
      .eq("platform", platform)
      .eq("seller_external_id", externalId)
      .maybeSingle()
  ) as { id: number } | null;
  return row?.id ?? null;
}

// ---- 3-1 セラーリサーチ: 集計結果の保存 ----

/**
 * 集計済みのセラー指標を seller_research_results に書き込む。
 *
 * 従来は「listings をDBに入れてから読み直して集計」していたが、
 * 回転日数と新品率は検索時にしか取れない情報なので、集計をメモリ上で
 * 済ませてからここで一括保存する(lib/engine/aggregate.ts 参照)。
 */
export async function saveSellerResults(
  searchId: number,
  stats: {
    seller_external_id: string;
    total_sold: number;
    avg_price: number;
    turnover_days: number | null;
    new_item_rate: number | null;
    genre_count: number;
    matched_keywords: string[];
    seller_type: string;
  }[],
  sellerIds: Map<string, number>,
  log: (m: string) => void = () => {}
): Promise<number> {
  const rows = stats
    .map((s) => {
      const id = sellerIds.get(s.seller_external_id);
      if (!id) return null;
      return {
        search_id: searchId,
        seller_id: id,
        total_sold: s.total_sold,
        avg_price: s.avg_price,
        turnover_days: s.turnover_days,
        new_item_rate: s.new_item_rate,
        genre_count: s.genre_count,
        seller_type: s.seller_type,
        matched_keyword: s.matched_keywords.join("、") || null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  let saved = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = must(
      await getSupabase()
        .from("seller_research_results")
        .upsert(chunk, { onConflict: "search_id,seller_id,matched_keyword" })
        .select("id")
    ) as { id: number }[] | null;
    saved += res?.length ?? 0;
  }
  log(`セラー集計: ${saved}件を保存`);
  return saved;
}

/**
 * セラーをまとめて登録し、外部ID→内部IDの対応表を返す。
 *
 * 1人ずつ upsertSeller() を呼ぶと「検索して無ければ作る」で1人あたり2往復かかる。
 * VPSからSupabase(ネットワーク越し)に60人ぶん投げると120往復になり、
 * 1往復50msでも6秒かかる。ここは1回のupsertと1回のselectで済ませる。
 */
export async function upsertSellers(
  profiles: Map<string, ScrapedSeller>,
  fallbackPlatform = "mercari"
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!profiles.size) return out;

  const sb = getSupabase();

  // プロフィールを取りに行ったセラーと、そうでないセラーを分けて書く。
  //
  // 分ける理由は2つ:
  //   ① 取りに行っていないセラーは名前以外が全部 null になる。同じ形で書くと
  //      以前に取れていたアバターや評価を null で塗り潰してしまう。
  //   ② PostgREST の一括upsertは、配列の全要素でキーが揃っている必要がある
  //      (揃っていないと「All object keys must match」で失敗する)。
  //      行ごとに項目を出し入れするのではなく、形の違う2組に分けて別々に書く。
  const detailed: Record<string, unknown>[] = [];
  const basic: Record<string, unknown>[] = [];

  for (const [sid, p] of profiles) {
    const platform = p?.platform ?? fallbackPlatform;
    const base = {
      platform,
      seller_external_id: sid,
      seller_name: p?.seller_name ?? sid,
      profile_url: p?.profile_url ?? null,
    };
    if (p && isFetchedProfile(p)) {
      detailed.push({
        ...base,
        rating: p.rating,
        review_count: p.review_count,
        avatar_url: p.avatar_url ?? null,
        listing_count: p.listing_count ?? null,
        good_ratings: p.good_ratings ?? null,
        bad_ratings: p.bad_ratings ?? null,
        registered_at: p.registered_at ?? null,
      });
    } else {
      basic.push(base);
    }
  }

  // (platform, seller_external_id) の一意制約で既存行は更新される
  for (const group of [detailed, basic]) {
    for (let i = 0; i < group.length; i += 200) {
      must(
        await sb
          .from("sellers")
          .upsert(group.slice(i, i + 200), { onConflict: "platform,seller_external_id" })
          .select("id")
      );
    }
  }

  // 採番された内部IDを引き直す(upsertの戻り順は保証されないためIDで引く)
  const rows = [...detailed, ...basic];
  const platforms = [...new Set(rows.map((r) => r.platform))];
  for (const platform of platforms) {
    const ids = rows.filter((r) => r.platform === platform).map((r) => r.seller_external_id as string);
    for (let i = 0; i < ids.length; i += 200) {
      const found = (must(
        await sb
          .from("sellers")
          .select("id, seller_external_id")
          .eq("platform", platform)
          .in("seller_external_id", ids.slice(i, i + 200))
      ) ?? []) as { id: number; seller_external_id: string }[];
      for (const f of found) out.set(f.seller_external_id, f.id);
    }
  }
  return out;
}
