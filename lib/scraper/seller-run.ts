/**
 * 発注仕様書 3-2 の実行本体。
 *
 * 「セラーIDを1つ受け取って、出品一覧の取得 → 実送料 → listings への保存 →
 *   鉄板商品(product_groups)の抽出」までをここに1本化している。
 *
 * 呼び出し口が3つあるので、同じ処理を3か所に書かないためにこのファイルへ寄せている
 * (3-3 の sourcing-run.ts と同じ考え方)。
 *   app/api/scrape/route.ts   … 画面のボタン(その場で実行する旧経路)
 *   scripts/worker.ts         … jobsテーブル経由の常駐ワーカー
 *   scripts/scrape-seller.ts  … コマンドライン
 *
 * ブラウザは「取得が終わった時点」で閉じる。保存と抽出はDBだけの処理なので、
 * そこまでブラウザを抱えたままにすると、その分だけ無駄に居座ることになる。
 */
import { MercariScraper, type DeepdiveListing } from "./mercari";
import type { SellerProfile } from "./mercari-seller";
import { findSellerId, saveListings, updateShipping } from "./persist";
import { run as clusterListings } from "../engine/cluster";
import { getSupabase, must } from "../supabase";
import { normalizeSellerId } from "./seller-id";
import type { ScrapedSeller } from "./types";

// セラーIDの正規化は /api/jobs からも使う。あちらに Playwright を持ち込まないよう
// 別ファイルに置いてあるが、ここから使う側は seller-run だけを見れば済むようにする。
export { normalizeSellerId };

/** 画面の進捗表示に出す段階。ScrapeRunner の PHASE_ORDER.seller と同じ並び */
export type SellerPhase = "list" | "ship" | "save" | "cluster";

/** 取得する出品数の上限(仕様書の上限) */
export const DEFAULT_MAX_ITEMS = 100;
/** 実送料を取りに行く件数。標準=上位3件 / 詳細=上位20件 */
export const DEFAULT_SHIPPING_TOP = 3;
export const DETAILED_SHIPPING_TOP = 20;
/** ページを開く間隔の既定値。短くするとブロックされやすくなる */
export const DEFAULT_INTERVAL_MS = 2500;

export type SellerRunOptions = {
  /** セラーID。メルカリShopsは "shops:<店舗ID>"。プロフィールURLを渡してもよい */
  sellerExternalId: string;
  /** 取得する出品数の上限(既定100) */
  maxItems?: number;
  /** 実送料を取りに行くSOLD上位件数(既定3) */
  shippingTop?: number;
  /** ページを開く間隔(ミリ秒) */
  intervalMs?: number;
  /** ブラウザを画面に出すか(動作確認用) */
  headless?: boolean;
  /** true ならDBに書かず、取得結果だけ返す */
  dryRun?: boolean;
  log?: (m: string) => void;
  onPhase?: (p: { phase: SellerPhase; done?: number; total?: number; label?: string }) => void;
};

export type SellerRunResult = {
  seller_external_id: string;
  /** sellers.id。dry-run と、保存できなかったときは null */
  seller_id: number | null;
  seller_name: string | null;
  /** 取得した出品数 */
  listings: number;
  sold: number;
  active: number;
  /** listings テーブルに新しく入った件数(既存行は saveListings が無視する) */
  saved: number;
  /** 実送料の内訳。fillRealShipping の集計をそのまま返す */
  shipping: { got: number; fixed: number; failed: number; na: number };
  /** 実送料を書き戻した行数 */
  shipping_updated: number;
  /** 抽出できた商品グループ数と、そのうちの鉄板商品(再出品あり)の数 */
  groups: number;
  repeat_groups: number;
  /** 取得した出品(dry-run で中身を見せたいとき用。DBには保存済み) */
  items: DeepdiveListing[];
  /** 画面で開く先 */
  result_href: string | null;
  /** 取得0件など、エラーではないが伝えるべきことがあれば入る */
  note: string | null;
};

/** 抽出後の商品グループ数を数える(結果表示用。失敗しても本処理は成立するので握りつぶす) */
async function countGroups(sellerId: number): Promise<{ groups: number; repeat: number }> {
  try {
    const sb = getSupabase();
    const all = await sb
      .from("product_groups")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", sellerId);
    const repeat = await sb
      .from("product_groups")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", sellerId)
      .eq("is_repeat", 1);
    must(all);
    must(repeat);
    return { groups: all.count ?? 0, repeat: repeat.count ?? 0 };
  } catch {
    return { groups: 0, repeat: 0 };
  }
}

export async function runSellerDeepdive(options: SellerRunOptions): Promise<SellerRunResult> {
  const {
    maxItems = DEFAULT_MAX_ITEMS,
    shippingTop = DEFAULT_SHIPPING_TOP,
    intervalMs = DEFAULT_INTERVAL_MS,
    headless = true,
    dryRun = false,
    log = () => {},
    onPhase = () => {},
  } = options;

  const sellerExternalId = normalizeSellerId(options.sellerExternalId);
  if (!sellerExternalId) throw new Error("セラーIDが指定されていません");

  const empty: SellerRunResult = {
    seller_external_id: sellerExternalId,
    seller_id: null,
    seller_name: null,
    listings: 0,
    sold: 0,
    active: 0,
    saved: 0,
    shipping: { got: 0, fixed: 0, failed: 0, na: 0 },
    shipping_updated: 0,
    groups: 0,
    repeat_groups: 0,
    items: [],
    result_href: null,
    note: null,
  };

  const scraper = new MercariScraper({ minIntervalMs: intervalMs, headless, log });
  let profile: SellerProfile | null = null;
  let listings: DeepdiveListing[] = [];
  let shipping = { got: 0, fixed: 0, failed: 0, na: 0 };

  try {
    await scraper.start();

    // ① 出品一覧(プロフィールも同じページから一緒に取れる)
    onPhase({ phase: "list", done: 0, total: maxItems });
    const fetched = await scraper.fetchSeller(sellerExternalId, maxItems, {
      onProgress: (got) =>
        onPhase({ phase: "list", done: Math.min(got, maxItems), total: maxItems, label: `${got}件` }),
    });
    profile = fetched.profile;
    listings = fetched.listings;

    if (!listings.length) {
      const note = "出品を取得できませんでした。セラーIDを確認してください。";
      log(note);
      return { ...empty, note };
    }

    const sold = listings.filter((l) => l.status === "sold").length;
    log(`取得: ${listings.length}件 (SOLD ${sold}件 / 販売中 ${listings.length - sold}件)`);

    // ② 実送料。商品ページを1件ずつ開くので、SOLDの上位N件だけに絞る
    onPhase({ phase: "ship", done: 0, total: Math.min(shippingTop, sold) });
    shipping = await scraper.fillRealShipping(listings, shippingTop, {
      onProgress: (done, total, r) => onPhase({ phase: "ship", done, total, label: r.reason }),
    });
  } finally {
    // 取得はここで終わり。保存と抽出はDBだけの処理なのでブラウザは閉じる
    await scraper.close();
  }

  const sold = listings.filter((l) => l.status === "sold").length;
  const base: SellerRunResult = {
    ...empty,
    seller_name: profile?.seller_name ?? null,
    listings: listings.length,
    sold,
    active: listings.length - sold,
    shipping,
    items: listings,
  };

  if (dryRun) {
    log("--dry-run のためDBには書きません。");
    return { ...base, note: "dry-run のため保存していません。" };
  }

  // ③ 保存
  onPhase({ phase: "save" });
  const profiles = new Map<string, ScrapedSeller>();
  if (profile) profiles.set(sellerExternalId, profile);
  const saved = await saveListings(listings, profiles, log);
  // 既存行は saveListings が無視するので、実送料だけは明示的に上書きする
  const shippingUpdated = await updateShipping(listings, log);

  const sellerId = await findSellerId("mercari", sellerExternalId);
  if (!sellerId) {
    throw new Error(`seller_id を解決できませんでした(${sellerExternalId})。`);
  }

  // ④ 鉄板商品の抽出
  onPhase({ phase: "cluster" });
  await clusterListings(sellerId, log);
  const counted = await countGroups(sellerId);

  return {
    ...base,
    seller_id: sellerId,
    saved: saved.inserted,
    shipping_updated: shippingUpdated,
    groups: counted.groups,
    repeat_groups: counted.repeat,
    result_href: `/seller-deepdive?seller_id=${sellerId}`,
  };
}
