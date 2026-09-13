/**
 * 発注仕様書 3-1 / 3-2 のメルカリ実装。
 *
 * 取得元はすべて **ログイン不要の公開ページ** を、Playwrightの実ブラウザでそのまま開いたもの。
 * 非公開の内部APIやトークンには触れていない。
 *
 * 読み方は2段構え:
 *   ① ページ自身が描画のために受け取ったレスポンス(JSON)を読む … 通常はこちら
 *      こちらから叩くのではなく、ページを開いた結果として届いたものを読むだけなので、
 *      アクセス回数はページを開く回数と変わらない。DOMに出ない項目(出品者ID・出品日時・
 *      配送方法・取引状態・実送料)が取れるのはこの経路だけ。
 *   ② レンダリング後のDOMを読む … ①が読めなかったときのフォールバック
 *
 * 開くページ:
 *   検索   : /search?keyword=...&status=sold_out&page_token=v1:N
 *   セラー : /user/profile/<セラーID>   (Shopsは /shops/profile/<店舗ID>)
 *   商品   : /item/<商品ID>             (Shopsは /shops/product/<商品ID>)
 *
 * DOM構造(2026-08時点で確認。フォールバック側で使う):
 *   一覧セル : li[data-testid="item-cell"]
 *              └ [role="img"][id="<商品ID>"][aria-label="<タイトル>の画像 [売り切れ ]<価格>円"]
 *              └ [data-testid="thumbnail-sticker"][aria-label="売り切れ"]   ← SOLD判定
 *
 * サイト構造が変わると壊れる前提の実装。壊れたときに原因が分かるよう、
 * 取得0件・セレクタ不一致は黙って握りつぶさずログに出す。
 */
import { relativeJaToDate, ScraperSession, type ScraperOptions } from "./browser";
import {
  buildSearchUrl,
  pageTokenOf,
  parseSearchResponse,
  parseShippingMethods,
  type MercariSearchResponse,
  type SearchItem,
} from "./mercari-search";
import {
  isShopItem,
  parseSellerItems,
  parseShopsProducts,
  parseShopProfile,
  parseUserProfile,
  realShippingOf,
  sortNewestFirst,
  type MercariGetItemsResponse,
  type MercariItemData,
  type MercariItemGetResponse,
  type MercariProfileResponse,
  type RealShipping,
  type SellerItem,
  type SellerProfile,
  type ShipStatus,
  type ShopsContentsResponse,
  type ShopsProductsResponse,
} from "./mercari-seller";
import {
  BlockedError,
  type ScrapedListing,
  type ScrapedSeller,
  type SellerDeepdiveAdapter,
  type SellerResearchAdapter,
} from "./types";
import { buildSearchQueries, parseSearchWords } from "./search-words";

/** ページ自身が受け取るレスポンスを捕捉するときのキー */
const CAPTURE_SEARCH = "search";
const CAPTURE_SHIPPING = "shippingMethods";
/** 3-2: セラーページ・商品ページが受け取るレスポンス */
const CAPTURE_USER_ITEMS = "userItems";
const CAPTURE_USER_PROFILE = "userProfile";
const CAPTURE_SHOP_PRODUCTS = "shopProducts";
const CAPTURE_SHOP_INFO = "shopInfo";
const CAPTURE_ITEM = "itemDetail";

const ORIGIN = "https://jp.mercari.com";
const CELL_SELECTOR = "li[data-testid='item-cell'] [role='img'][id]";
export const PLATFORM = "mercari";

/** 一覧セルから取れる生データ */
type RawCell = { id: string; aria: string | null; sticker: string | null; img: string | null };

/** ブラウザ内で実行される抽出関数(page.evaluate に渡すのでスコープを持てない) */
function extractCells(): RawCell[] {
  const out: RawCell[] = [];
  for (const li of Array.from(document.querySelectorAll("li[data-testid='item-cell']"))) {
    const thumb = li.querySelector("[role='img'][aria-label][id]") as HTMLElement | null;
    if (!thumb || !thumb.id) continue;
    out.push({
      id: thumb.id,
      aria: thumb.getAttribute("aria-label"),
      sticker: li.querySelector("[data-testid='thumbnail-sticker']")?.getAttribute("aria-label") ?? null,
      img: li.querySelector("img")?.getAttribute("src") ?? null,
    });
  }
  return out;
}

/** "COACH ポーチの画像 売り切れ 2,500円" → { title, price, sold } */
export function parseAria(aria: string | null): { title: string; price: number; sold: boolean } | null {
  if (!aria) return null;
  const m = aria.match(/^([\s\S]*)の画像\s*(売り切れ)?\s*([\d,]+)円\s*$/);
  if (!m) return null;
  const price = Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(price)) return null;
  return { title: m[1].trim(), price, sold: Boolean(m[2]) };
}

/** メルカリShopsの商品IDは m+数字 ではない */
export function isShopsItem(id: string): boolean {
  return !/^m\d+$/.test(id);
}

export function itemUrl(id: string): string {
  return isShopsItem(id) ? `${ORIGIN}/shops/product/${id}` : `${ORIGIN}/item/${id}`;
}

/**
 * 配送方法名 → 実送料(円)。
 * メルカリの公開している全国一律料金のうち、**サイズまで一意に決まるもの** だけを表に持つ。
 * 「らくらくメルカリ便」のように名前だけでサイズが分からないものは null(=取得不可)を返す。
 * 普通郵便・定形外・未定なども仕様通り null。
 */
const SHIPPING_TABLE: [RegExp, number][] = [
  [/ゆうパケットポストmini/, 160],
  [/ゆうパケットポスト/, 215],
  [/ゆうパケットプラス/, 455],
  [/ゆうパケット/, 230],
  [/ネコポス/, 210],
  [/宅急便コンパクト/, 450],
  [/コンパクト/, 450],
  [/^\s*ゆうパック\s*\(?\s*60/, 770],
  [/^\s*ゆうパック\s*\(?\s*80/, 870],
  [/^\s*ゆうパック\s*\(?\s*100/, 1070],
  [/宅急便\s*\(?\s*60/, 750],
  [/宅急便\s*\(?\s*80/, 850],
  [/宅急便\s*\(?\s*100/, 1050],
];

export function shippingCostFromMethod(method: string | null): number | null {
  if (!method) return null;
  for (const [re, yen] of SHIPPING_TABLE) if (re.test(method)) return yen;
  return null;
}

/** 商品ページから読み取れる詳細 */
export type ItemDetail = {
  external_id: string;
  title: string | null;
  price: number | null;
  sold: boolean;
  seller_external_id: string | null;
  seller_name: string | null;
  shipping_method: string | null;
  shipping_cost: number | null;
  /** 商品ページの「商品の状態」欄の文言 */
  condition: string | null;
  /** 「新品、未使用」なら true。読めなければ null */
  is_new: boolean | null;
  /** 出品日時。レスポンスから取れれば正確な値、画面からなら相対表記("7時間前")の概算 */
  listed_at: string | null;
  /** 最終更新日時(ISO)。レスポンスから取れたときだけ入る */
  updated_at: string | null;
  /**
   * 取引の状態(done / wait_review / wait_shipping / wait_payment など)。生の値。
   * 送料が確定しているかは shipping.shipping_confirmed を見ること
   * (発送された時点で確定し、取引完了は待たないため)。
   */
  transaction_status: string | null;
  /** 実送料の取得結果(金額・取得状況・理由) */
  shipping: RealShipping;
};

/**
 * 3-2 が返す出品データ。
 *
 * `ScrapedListing`(= listings テーブルの形)に、セラーページのレスポンスから
 * 追加で取れる項目を足したもの。persist.ts がそのまま列に流し込む。
 */
export type DeepdiveListing = ScrapedListing & {
  /** 商品の状態。一覧レスポンスには含まれないので常に null(商品ページを開けば取れる) */
  is_new: boolean | null;
  /** 最終更新日時。売却日時ではないが、回転日数の推定に使う */
  updated_at: string | null;
  shipping_method_id: string | null;
  is_shops: boolean;
  /**
   * 送料が確定しているか(＝発送済みか)。実送料を取りに行く順番を決めるのに使う。
   * 一覧の時点では取りこぼす(古い出品では取引情報が省かれる)が、
   * fillRealShipping() で商品ページを開いた分は確定値に上書きされる。
   */
  shipping_confirmed: boolean;
  /** 購入されたがまだ発送されていない。送料が未確定なので優先度を下げる */
  before_shipping: boolean;
  /** 実送料の取得状況。既定は skip(=まだ取りに行っていない) */
  ship_status: ShipStatus;
  /** 発送時に確定したサイズ区分名(「ネコポス」など)。取れたときだけ入る */
  ship_class: string | null;
};

export class MercariScraper implements SellerResearchAdapter, SellerDeepdiveAdapter {
  readonly platformName = PLATFORM;
  private session: ScraperSession;
  private log: (m: string) => void;
  /** 配送方法マスタ(id→名前)。検索ページを開いたときに一緒に降ってくる */
  private shippingMethods: Record<string, string> = {};

  constructor(private options: ScraperOptions = {}) {
    this.session = new ScraperSession(options);
    this.log = options.log ?? (() => {});
  }

  async start() {
    await this.session.start();
  }
  async close() {
    await this.session.close();
  }

  // ---------------------------------------------------------------- 3-1
  /**
   * 発注仕様書 3-1: キーワードでSOLD商品を検索し、新しい順に maxPages 分取得する。
   *
   * 取得のしかた:
   *   検索結果ページを1ページずつ普通に開き、**ページ自身が描画のために受け取った
   *   検索レスポンス** を読む(lib/scraper/mercari-search.ts 参照)。
   *   このレスポンスには各商品の出品者IDが最初から入っているため、
   *   **追加のアクセスを増やさずに全件の出品者が分かる**。
   *   1ページ約110件なので、10ページで1キーワードあたり約1,100件になる。
   *
   *   出品者「名」は検索レスポンスに含まれないため、ここではIDのみを埋める。
   *   名前は集計後に必要なセラーの分だけ resolveSellerNames() で解決する
   *   (全件の名前を引くと無駄なアクセスが増えるため。参考にした既存サービスも
   *    「巡回」と「セラー名の取得」を別フェーズに分けている)。
   *
   * @param keyword     検索キーワード(1語、または複数。文字列でも配列でも可)
   * @param aruaruWords 「あるあるワード」。指定すると各キーワードと組み合わせて個別に検索する
   * @param maxPages    1クエリあたり読むページ数(目安10)
   */
  async searchSold(
    keyword: string | string[],
    aruaruWords: string[] = [],
    maxPages = 10,
    opts: {
      /** 中古も対象に含めるか(既定false=新品、未使用のみ)。せどり用途で true にする */
      includeUsed?: boolean;
      /** ページを1枚読むごとに呼ばれる。進捗表示用 */
      onPage?: (info: { query: string; page: number; pages: number; got: number; total: number; numFound: number | null }) => void;
    } = {}
  ): Promise<(ScrapedListing & { matched_keyword: string; is_new: boolean | null; updated_at: string | null })[]> {
    const includeUsed = opts.includeUsed ?? false;
    // キーワードは複数可(OR)。あるあるがあれば keyword × あるある の組み合わせで検索する
    const keywords = parseSearchWords(keyword);
    if (!keywords.length) throw new Error("キーワードが必要です");
    const queries = buildSearchQueries(keywords, aruaruWords);

    // ページ自身が受け取る検索レスポンスと配送方法マスタを捕捉する
    this.session.captureJson(CAPTURE_SEARCH, /\/v2\/entities:search/);
    this.session.captureJson(CAPTURE_SHIPPING, /datasets\/shipping_methods/);

    const collected = new Map<string, SearchItem & { matched: string }>();

    for (const q of queries) {
      let emptyPages = 0;
      for (let p = 0; p < maxPages; p++) {
        const url = buildSearchUrl(q, pageTokenOf(p));
        this.session.clearCaptured(CAPTURE_SEARCH);
        this.log(`  検索: "${q}" ${p + 1}/${maxPages}ページ目`);
        await this.session.goto(url, 1500);

        // 描画のためのレスポンスが届くまで待つ(固定sleepより確実)
        const responses = await this.session.waitForCaptured<MercariSearchResponse>(CAPTURE_SEARCH, 25000);

        // 配送方法マスタは初回だけ届く。届いたら覚えておく
        for (const m of this.session.takeCaptured(CAPTURE_SHIPPING)) {
          const table = parseShippingMethods(m);
          if (Object.keys(table).length) {
            this.shippingMethods = { ...this.shippingMethods, ...table };
            this.log(`  配送方法マスタを取得(${Object.keys(table).length}種)`);
          }
        }

        if (!responses.length) {
          // 検索レスポンスが取れない = 描画されていない or 仕様変更
          emptyPages++;
          this.log(`  → 検索結果を受け取れませんでした(${emptyPages}回目)`);
          if (emptyPages >= 2) {
            throw new Error(
              `検索結果を取得できませんでした: "${q}" ${p + 1}ページ目。` +
                `メルカリ側の仕様変更か、アクセスが制限されている可能性があります。`
            );
          }
          continue;
        }
        emptyPages = 0;

        let added = 0;
        let pageCount = 0;
        let skipped = 0;
        let last: string | null = null;
        let found: number | null = null;
        for (const res of responses) {
          const parsed = parseSearchResponse(res, this.shippingMethods);
          pageCount += parsed.items.length;
          skipped += parsed.skipped;
          last = parsed.nextPageToken;
          if (parsed.numFound !== null) found = parsed.numFound;
          for (const it of parsed.items) {
            if (!collected.has(it.external_id)) {
              collected.set(it.external_id, { ...it, matched: q });
              added++;
            }
          }
        }
        this.log(
          `  → ${pageCount}件(新規${added}件, 累計${collected.size}件)` + (skipped ? ` ※形式不明で除外${skipped}件` : "")
        );
        if (p === 0 && found !== null) this.log(`  メルカリ側の総ヒット数: ${found.toLocaleString()}件`);
        opts.onPage?.({ query: q, page: p + 1, pages: maxPages, got: pageCount, total: collected.size, numFound: found });

        // 次のページが無い/新規が増えないなら、そのクエリは終端
        if (!last) {
          this.log(`  → 最終ページに到達しました`);
          break;
        }
        if (added === 0) {
          this.log(`  → 新しい商品が出てこなくなったので打ち切ります`);
          break;
        }
      }
    }

    // SOLD(取引中を含む)のみを対象にする
    const sold = [...collected.values()].filter((c) => c.sold);
    this.log(`検索完了: ${collected.size}件中 売れた出品 ${sold.length}件 / セラー ${new Set(sold.map((s) => s.seller_external_id)).size}人`);

    return sold.map((c) => ({
      platform: PLATFORM,
      external_id: c.external_id,
      seller_external_id: c.seller_external_id,
      // 名前は検索レスポンスに無い。集計後に resolveSellerNames() で解決する
      seller_name: c.seller_external_id,
      title: c.title,
      price: c.price,
      status: "sold" as const,
      listed_at: c.listed_at,
      // 売却日時は公開されていないため取得不可(仕様書の想定どおり)
      sold_at: null,
      shipping_method: c.shipping_method,
      shipping_cost: shippingCostFromMethod(c.shipping_method),
      image_url: c.image_url,
      listing_url: c.listing_url,
      matched_keyword: c.matched,
      is_new: c.is_new,
      updated_at: c.updated_at,
    }));
  }

  /**
   * セラーIDの一覧から名前を解決する。
   *
   * 検索レスポンスには出品者名が入っていないため、必要なセラーの分だけ
   * プロフィールページを開いて名前を取る。集計して上位N人に絞ってから呼ぶこと。
   * 1人ずつレート制限がかかるので、100人を超えると相応の時間がかかる。
   */
  async resolveSellerNames(
    sellerIds: string[],
    opts: { onProgress?: (done: number, total: number, name: string) => void } = {}
  ): Promise<Map<string, ScrapedSeller>> {
    const out = new Map<string, ScrapedSeller>();
    const ids = [...new Set(sellerIds)];
    this.log(`セラー名の取得: ${ids.length}人`);
    for (const [i, sid] of ids.entries()) {
      try {
        const prof = await this.getSellerProfile(sid);
        if (prof) out.set(sid, prof);
        opts.onProgress?.(i + 1, ids.length, prof?.seller_name ?? sid);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        this.log(`  ${sid} の名前が取れませんでした: ${String(e).slice(0, 80)}`);
      }
    }
    this.log(`セラー名の取得: ${out.size}/${ids.length}人`);
    return out;
  }


  // ---------------------------------------------------------------- 3-2
  //
  // セラー深掘り。
  //
  // 3-1 と同じく「ページを普通に開いて、ページ自身が描画のために受け取った
  // レスポンスを読む」方式にしてある。理由は lib/scraper/mercari-seller.ts の
  // 冒頭コメントの通りで、一覧のDOMには出品日時・配送方法・取引状態が無く、
  // DOMだけでは回転日数も実送料の取得可否も判定できないため。
  //
  // レスポンスが読めなかった場合は、DOMから読む従来の方法にそのまま切り替える
  // (取れる項目は減るが、タイトル・価格・売り切れだけは取れる)。

  /** 3-2 で捕捉するレスポンスのキー一覧 */
  private static readonly DEEPDIVE_CAPTURES = [
    CAPTURE_USER_ITEMS,
    CAPTURE_USER_PROFILE,
    CAPTURE_SHOP_PRODUCTS,
    CAPTURE_SHOP_INFO,
    CAPTURE_ITEM,
  ];

  /**
   * 捕捉済みのレスポンスを全部捨てる。ページを開く直前に必ず呼ぶ。
   *
   * どのページも目的以外のレスポンスを一緒に受け取る(商品ページを開くと、その出品者の
   * 他の出品一覧も降ってくる)。読まないまま溜め続けると、セラーを何十人も回る実行で
   * メモリを圧迫するため、使わないものはここで捨てる。
   */
  private clearDeepdiveCaptures(): void {
    for (const k of MercariScraper.DEEPDIVE_CAPTURES) this.session.clearCaptured(k);
  }

  /** 3-2 で使うレスポンス捕捉をまとめて有効にする(二重登録はされない) */
  private enableDeepdiveCapture(): void {
    this.session.captureJson(CAPTURE_USER_ITEMS, /\/items\/get_items/);
    this.session.captureJson(CAPTURE_USER_PROFILE, /\/users\/get_profile/);
    this.session.captureJson(CAPTURE_SHOP_PRODUCTS, /shops\/v1\/shops\/[^/]+\/products/);
    // 同じ階層に /coupons もあるので、店舗情報そのものだけに当たるようにする
    this.session.captureJson(CAPTURE_SHOP_INFO, /shops\/v1\/contents\/shops\/[^/?]+(\?|$)/);
    this.session.captureJson(CAPTURE_ITEM, /\/items\/get\?id=/);
    // 配送方法マスタは検索ページでしか降ってこないが、来たら覚えておく
    this.session.captureJson(CAPTURE_SHIPPING, /datasets\/shipping_methods/);
  }

  /**
   * 発注仕様書 3-2: 指定セラーの出品一覧を新しい順に最大 maxItems 件取得する。
   *
   * セラーページを1回だけ開き、続きは画面を下へスクロールして読み込ませる
   * (＝利用者と同じ操作)。1回の追加読み込みで30件ずつ増えるので、
   * 100件なら追加読み込みは3回程度で済む。
   */
  async getSellerListings(sellerExternalId: string, maxItems = 100): Promise<DeepdiveListing[]> {
    const { listings } = await this.fetchSeller(sellerExternalId, maxItems);
    return listings;
  }

  /**
   * セラーのプロフィールと出品一覧を、ページを**1回だけ**開いて両方取得する。
   *
   * getSellerProfile() と getSellerListings() を続けて呼ぶと同じページを2回開くことになる。
   * 深掘りはセラー数ぶん繰り返す処理なので、ここをまとめるだけでアクセス回数が半分になる。
   */
  async fetchSeller(
    sellerExternalId: string,
    maxItems = 100,
    opts: { onProgress?: (got: number) => void } = {}
  ): Promise<{ profile: SellerProfile | null; listings: DeepdiveListing[] }> {
    const isShops = sellerExternalId.startsWith("shops:");
    this.enableDeepdiveCapture();
    this.clearDeepdiveCaptures();

    const url = this.profileUrl(sellerExternalId);
    this.log(`セラー ${sellerExternalId} の出品一覧を取得します(最大${maxItems}件)`);
    await this.session.goto(url, 1500);

    const itemsKey = isShops ? CAPTURE_SHOP_PRODUCTS : CAPTURE_USER_ITEMS;
    const profileKey = isShops ? CAPTURE_SHOP_INFO : CAPTURE_USER_PROFILE;

    // ① プロフィール(名前・評価)
    let profile: SellerProfile | null = null;
    for (const res of await this.session.waitForCaptured<unknown>(profileKey, 15000)) {
      const p = isShops
        ? parseShopProfile(res as ShopsContentsResponse, sellerExternalId)
        : parseUserProfile(res as MercariProfileResponse, sellerExternalId);
      if (p) {
        profile = p;
        break;
      }
    }
    if (!profile) {
      // レスポンスが読めなかったときは画面から読む
      profile = await this.readProfileFromDom(sellerExternalId);
    }
    if (profile) {
      this.log(
        `  セラー名: ${profile.seller_name}` +
          (profile.review_count !== null ? ` (評価${profile.review_count.toLocaleString()}件)` : "") +
          (profile.listing_count !== null ? ` / 総出品数${profile.listing_count.toLocaleString()}件` : "")
      );
    }

    // ② 出品一覧
    const collected = new Map<string, SellerItem>();
    let hasNext = false;
    let skipped = 0;
    let archived = 0;

    const absorb = (responses: unknown[]): number => {
      let added = 0;
      for (const res of responses) {
        if (isShops) {
          const p = parseShopsProducts(res as ShopsProductsResponse, sellerExternalId);
          skipped += p.skipped;
          hasNext = Boolean(p.nextPageToken);
          for (const it of p.items) {
            if (!collected.has(it.external_id)) {
              collected.set(it.external_id, it);
              added++;
            }
          }
        } else {
          const p = parseSellerItems(
            res as MercariGetItemsResponse,
            sellerExternalId,
            this.shippingMethods
          );
          skipped += p.skipped;
          archived += p.archived;
          hasNext = p.hasNext;
          for (const it of p.items) {
            if (!collected.has(it.external_id)) {
              collected.set(it.external_id, it);
              added++;
            }
          }
        }
      }
      return added;
    };

    absorb(await this.session.waitForCaptured<unknown>(itemsKey, 25000));

    if (collected.size) {
      this.log(`    … ${collected.size}件`);
      opts.onProgress?.(collected.size);
    }

    // 足りなければ、画面を下へスクロールして続きを読み込ませる
    let stagnant = 0;
    while (collected.size < maxItems && hasNext && stagnant < 3) {
      const more = await this.session.loadMoreCaptured<unknown>(itemsKey);
      if (!more.length) {
        stagnant++;
        continue;
      }
      const added = absorb(more);
      if (added === 0) {
        stagnant++;
        continue;
      }
      stagnant = 0;
      this.log(`    … ${collected.size}件`);
      opts.onProgress?.(collected.size);
    }

    if (skipped) this.log(`  ※形式が読めず除外: ${skipped}件`);
    if (archived) this.log(`  ※出品者が非公開にした商品を除外: ${archived}件`);

    // ③ レスポンスが1件も読めなかったときは、画面の一覧から取る
    if (!collected.size) {
      this.log(`  → レスポンスから出品を読み取れませんでした。画面の一覧から取得します(取れる項目は減ります)`);
      const listings = await this.harvestListingsFromDom(sellerExternalId, profile, maxItems);
      return { profile, listings };
    }

    const sellerName = profile?.seller_name ?? sellerExternalId;
    const ordered = sortNewestFirst([...collected.values()]).slice(0, maxItems);
    const listings: DeepdiveListing[] = ordered.map((c) => ({
      platform: PLATFORM,
      external_id: c.external_id,
      seller_external_id: sellerExternalId,
      seller_name: sellerName,
      title: c.title,
      price: c.price,
      status: c.sold ? "sold" : "active",
      listed_at: c.listed_at,
      // 売却日時は公開されていない。回転日数は updated_at との差で推定する
      sold_at: null,
      shipping_method: c.shipping_method,
      // 実送料は商品ページを開かないと分からない。getRealShipping() で上位N件だけ取る
      shipping_cost: null,
      image_url: c.image_url,
      listing_url: c.listing_url,
      is_new: null,
      updated_at: c.updated_at,
      shipping_method_id: c.shipping_method_id,
      is_shops: c.is_shops,
      shipping_confirmed: c.shipping_confirmed,
      before_shipping: c.before_shipping,
      ship_status: "skip",
      ship_class: null,
    }));

    const sold = listings.filter((l) => l.status === "sold").length;
    this.log(`  → ${listings.length}件を取得(SOLD ${sold}件 / 販売中 ${listings.length - sold}件)`);
    return { profile, listings };
  }

  /** セラーIDからプロフィールURLを組み立てる("shops:" 付きはメルカリShops) */
  profileUrl(sellerExternalId: string): string {
    return sellerExternalId.startsWith("shops:")
      ? `${ORIGIN}/shops/profile/${encodeURIComponent(sellerExternalId.slice(6))}`
      : `${ORIGIN}/user/profile/${encodeURIComponent(sellerExternalId)}`;
  }

  /**
   * セラーのプロフィール(名前・評価)を取得する。
   *
   * 出品一覧も要るなら fetchSeller() を使うこと。こちらは 3-1 の
   * 「集計後に上位N人ぶんの名前だけ引く」用途を想定していて、一覧は読まない。
   */
  async getSellerProfile(sellerExternalId: string): Promise<ScrapedSeller | null> {
    const isShops = sellerExternalId.startsWith("shops:");
    this.enableDeepdiveCapture();
    const profileKey = isShops ? CAPTURE_SHOP_INFO : CAPTURE_USER_PROFILE;
    this.clearDeepdiveCaptures();

    await this.session.goto(this.profileUrl(sellerExternalId), 1200);

    for (const res of await this.session.waitForCaptured<unknown>(profileKey, 15000)) {
      const p = isShops
        ? parseShopProfile(res as ShopsContentsResponse, sellerExternalId)
        : parseUserProfile(res as MercariProfileResponse, sellerExternalId);
      if (p) return p;
    }
    return await this.readProfileFromDom(sellerExternalId);
  }

  /**
   * プロフィールを画面から読む(レスポンスが読めなかったときのフォールバック)。
   * ページはすでに開かれている前提。
   */
  private async readProfileFromDom(sellerExternalId: string): Promise<SellerProfile | null> {
    // 名前が描画されるまで待つ。固定待ちだと、まだ出ていないパンくず(「ホーム」)を
    // 名前と誤認することがあるため。
    await this.session.waitForAny("h1", 12000);
    const page = this.session.currentPage;

    const info = await page.evaluate(() => {
      const text = document.body.innerText;
      // 「101」のような評価数は名前のすぐ下、「本人確認済」の手前に出る
      const ratingCount = text.match(/(\d[\d,]*)\s*\n\s*(本人確認済|フォロー)/);
      const listingCount = text.match(/(\d[\d,]*)\s*出品数/);
      // プロフィール画像。メルカリの画像CDNから来ているものだけを拾う
      // (商品サムネイルを誤って掴まないよう、member_photo か shops のロゴに限定)
      const avatar = Array.from(document.querySelectorAll("img"))
        .map((i) => i.getAttribute("src") ?? "")
        .find((s) => /member_photo|mercari-shops-static/.test(s) && !/noimage/.test(s));
      return {
        title: document.title,
        h1: document.querySelector("h1")?.textContent?.trim() ?? null,
        head: text.slice(0, 300),
        ratingCount: ratingCount ? ratingCount[1] : null,
        listingCount: listingCount ? listingCount[1] : null,
        avatar: avatar ?? null,
      };
    });

    // 共通ナビやパンくずの文言。これらは絶対にセラー名ではない
    const NAV = [
      "コンテンツにスキップ",
      "ログイン",
      "会員登録",
      "出品",
      "日本語",
      "プロフィール",
      "ホーム",
      "メルカリShops",
      "メルカリ",
    ];
    // ページによって「しずく の出品した商品」「しずくさんのプロフィール」など
    // 名前に定型の接尾辞が付くので落とす
    const stripSuffix = (t: string) =>
      t
        .replace(/\s*の出品した商品\s*$/, "")
        .replace(/\s*さんのプロフィール\s*$/, "")
        .replace(/\s*のプロフィール\s*$/, "")
        .trim();

    const clean = (v: string | null | undefined) => {
      const t = stripSuffix((v ?? "").trim());
      return t && !NAV.includes(t) && !/^\d[\d,]*$/.test(t) ? t : null;
    };

    // ① タイトル: 通常出品は「<名前>さんのプロフィール」、Shopsは「<店名> - メルカリShops」
    const fromTitle =
      clean(info.title.match(/^(.+?)さんのプロフィール/)?.[1]) ??
      clean(info.title.match(/^(.+?)\s*[-|｜]\s*メルカリ/)?.[1]);
    // ② h1: メルカリShopsのプロフィールは h1 が店名そのもの
    const fromH1 = clean(info.h1);
    // ③ 最後の手段として本文先頭の行
    const fromBody = info.head
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(clean)
      .find(Boolean);

    const name = fromTitle ?? fromH1 ?? fromBody ?? null;
    if (!name) {
      this.log(`  セラー ${sellerExternalId}: 名前を取得できませんでした`);
      return null;
    }
    const toNum = (v: string | null) => (v ? Number(v.replace(/,/g, "")) : null);
    return {
      platform: PLATFORM,
      seller_external_id: sellerExternalId,
      seller_name: name,
      // ★評価はレスポンスにしか無い。画面からは評価件数しか読めない
      rating: null,
      review_count: toNum(info.ratingCount),
      profile_url: this.profileUrl(sellerExternalId),
      avatar_url: info.avatar,
      listing_count: toNum(info.listingCount),
      good_ratings: null,
      bad_ratings: null,
      registered_at: null,
    };
  }

  /**
   * 出品一覧を画面から読む(レスポンスが読めなかったときのフォールバック)。
   * ページはすでに開かれている前提。出品日時・配送方法・取引状態は取れない。
   */
  private async harvestListingsFromDom(
    sellerExternalId: string,
    profile: SellerProfile | null,
    maxItems: number
  ): Promise<DeepdiveListing[]> {
    const sellerName = profile?.seller_name ?? sellerExternalId;
    const cells = await this.session.harvestWhileScrolling<RawCell>(extractCells, {
      // セラーページは初期表示30件ほどで止まり、「もっと見る」を押すと続きが出る
      maxScrolls: Math.max(40, Math.ceil(maxItems / 2)),
      stopAfter: maxItems,
      waitFor: CELL_SELECTOR,
      loadMoreText: ["もっと見る", "さらに表示"],
      onProgress: (n) => {
        if (n % 25 === 0) this.log(`    … ${n}件`);
      },
    });

    const listings: DeepdiveListing[] = [];
    for (const c of cells) {
      const parsed = parseAria(c.aria);
      if (!parsed) continue;
      const sold = parsed.sold || c.sticker === "売り切れ";
      listings.push({
        platform: PLATFORM,
        external_id: c.id,
        seller_external_id: sellerExternalId,
        seller_name: sellerName,
        title: parsed.title,
        price: parsed.price,
        status: sold ? "sold" : "active",
        listed_at: null,
        sold_at: null,
        shipping_method: null,
        shipping_cost: null,
        image_url: c.img,
        listing_url: itemUrl(c.id),
        is_new: null,
        updated_at: null,
        shipping_method_id: null,
        is_shops: isShopsItem(c.id),
        shipping_confirmed: false,
        before_shipping: false,
        ship_status: "skip",
        ship_class: null,
      });
    }
    const sold = listings.filter((l) => l.status === "sold").length;
    this.log(`  → ${listings.length}件を取得(SOLD ${sold}件 / 販売中 ${listings.length - sold}件)`);
    return listings;
  }

  /**
   * 商品ページから詳細(出品者・配送方法・実送料など)を読む。
   *
   * ページが受け取る商品詳細レスポンスを読む。読めなかったときだけ画面から読む
   * (画面には実送料が出ないので、その場合 shipping_cost は取れない)。
   */
  async getItemDetail(externalId: string): Promise<ItemDetail | null> {
    this.enableDeepdiveCapture();
    this.clearDeepdiveCaptures();

    const url = itemUrl(externalId);
    await this.session.goto(url, 800);

    // メルカリShopsの商品ページは items/get を使わないので待たない
    if (!isShopsItem(externalId)) {
      const responses = await this.session.waitForCaptured<MercariItemGetResponse>(CAPTURE_ITEM, 15000);
      const data =
        responses.map((r) => r?.data).find((d): d is MercariItemData => Boolean(d && d.id === externalId)) ??
        responses.map((r) => r?.data).find((d): d is MercariItemData => Boolean(d)) ??
        null;
      if (data) return this.itemDetailFromResponse(externalId, data);
      this.log(`  ${externalId}: 商品情報のレスポンスを受け取れませんでした。画面から読みます`);
    }
    return await this.readItemDetailFromDom(externalId);
  }

  /** 商品詳細レスポンス → ItemDetail */
  private itemDetailFromResponse(externalId: string, d: MercariItemData): ItemDetail {
    const shipping = realShippingOf(d);
    const sellerId = d.seller?.id !== undefined && d.seller?.id !== null ? String(d.seller.id) : null;
    const condition = d.item_condition?.name ?? null;
    return {
      external_id: externalId,
      title: d.name ?? null,
      price: typeof d.price === "number" ? d.price : null,
      sold: d.status === "sold_out" || d.status === "trading",
      seller_external_id: sellerId && isShopItem(d.is_shop_item) ? `shops:${sellerId}` : sellerId,
      seller_name: d.seller?.name && d.seller.name !== "dont-use-this" ? d.seller.name : null,
      shipping_method: shipping.method,
      shipping_cost: shipping.cost,
      condition,
      is_new: condition ? condition.includes("新品") : null,
      listed_at: d.created ? new Date(d.created * 1000).toISOString() : null,
      updated_at: d.updated ? new Date(d.updated * 1000).toISOString() : null,
      transaction_status: d.transaction_evidence?.status ?? null,
      shipping,
    };
  }

  /**
   * 商品ページを画面から読む(レスポンスが読めなかったときのフォールバック)。
   * ページはすでに開かれている前提。実送料は画面に出ないので配送方法名だけで判断する。
   */
  private async readItemDetailFromDom(externalId: string): Promise<ItemDetail | null> {
    const page = this.session.currentPage;

    // 固定の待ち時間だと、描画が間に合わないときに「取得できなかった」のか
    // 「もともと無い」のか区別がつかなくなる。主要な要素が出るまで待つ。
    // (出品者リンクは商品ページの中でも遅れて描画されることがある)
    await this.session.waitForAny("h1", 15000);
    await this.session.waitForAny(
      "a[href^='/user/profile/'], a[href^='/shops/profile/'], [data-testid='seller-link']",
      12000
    );
    // 「商品の情報」表は出品者リンクより後に描画されることがあるので少しだけ待つ
    await page.waitForTimeout(1200);

    const d = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const sellerA = document.querySelector("a[href^='/user/profile/']") as HTMLAnchorElement | null;
      const shopA = document.querySelector("a[href^='/shops/']") as HTMLAnchorElement | null;
      const sellerLink = document.querySelector("[data-testid='seller-link']");

      // 「商品の情報」表から 配送の方法 / 配送料の負担 を読む
      const readRow = (label: string): string | null => {
        for (const el of Array.from(document.querySelectorAll("span,div,dt,th"))) {
          if (el.textContent?.trim() === label) {
            const sib = el.nextElementSibling ?? el.parentElement?.nextElementSibling;
            const v = sib?.textContent?.trim();
            if (v) return v;
          }
        }
        const m = bodyText.match(new RegExp(label + "\\s*\\n\\s*([^\\n]+)"));
        return m ? m[1].trim() : null;
      };

      return {
        title: document.querySelector("h1")?.textContent?.trim() ?? null,
        priceText: document.querySelector("[data-testid='price']")?.textContent ?? null,
        sold: /売り切れました|売り切れ|SOLD/.test(bodyText),
        sellerHref: sellerA?.getAttribute("href") ?? null,
        shopHref: shopA?.getAttribute("href") ?? null,
        shopText: shopA?.textContent?.trim() ?? null,
        sellerText: sellerLink?.textContent?.trim() ?? null,
        shippingMethod: readRow("配送の方法"),
        condition: readRow("商品の状態"),
        shippingPayer: readRow("配送料の負担"),
        bodyText: bodyText.slice(0, 4000),
      };
    });

    // 通常出品は /user/profile/<数字ID>、メルカリShopsは /shops/profile/<base62 ID>。
    // 名前空間が違うので、Shops側は "shops:" を付けて区別する。
    let sellerId: string | null = null;
    if (d.sellerHref) {
      sellerId = d.sellerHref.replace(/^\/user\/profile\//, "").split(/[/?#]/)[0] || null;
    } else if (d.shopHref) {
      const m = d.shopHref.match(/^\/shops\/profile\/([^/?#]+)/);
      if (m) sellerId = `shops:${m[1]}`;
    }
    // seller-link のテキストは「しずく\n\n101\n本人確認済」のような複数行
    const sellerName =
      d.sellerText?.split("\n").map((s) => s.trim()).filter(Boolean)[0] ??
      d.shopText?.split("\n").map((s) => s.trim()).filter(Boolean)[0] ??
      null;
    const price = d.priceText ? Number(d.priceText.replace(/[^\d]/g, "")) : null;
    const relTime = d.bodyText.match(/\d+\s*(秒|分|時間|日|ヶ月|か月|カ月|年)前/);

    // 画面に出るのは配送方法名だけ。実送料の判定はレスポンス版と同じ関数に通して、
    // 「取れなかった」のか「そもそも対象外」なのかを同じ基準で分ける。
    const shipping = realShippingOf({
      shipping_method: d.shippingMethod ? { name: d.shippingMethod } : undefined,
      shipping_payer: d.shippingPayer?.includes("着払い") ? { code: "buyer", name: d.shippingPayer } : undefined,
      transaction_evidence: d.sold ? { status: "done" } : null,
    });

    return {
      external_id: externalId,
      title: d.title,
      price: Number.isFinite(price) ? price : null,
      sold: d.sold,
      seller_external_id: sellerId,
      seller_name: sellerName,
      shipping_method: d.shippingMethod,
      shipping_cost: shipping.cost,
      condition: d.condition,
      is_new: d.condition ? d.condition.includes("新品") : null,
      listed_at: relTime ? relativeJaToDate(relTime[0]) : null,
      updated_at: null,
      // 画面には取引の細かい状態が出ないので、売り切れかどうかしか分からない
      transaction_status: d.sold ? "done" : null,
      shipping,
    };
  }

  /**
   * 発注仕様書 3-2: 取引完了済みの商品ページから実送料を取得する。
   *
   * インターフェース(SellerDeepdiveAdapter)に合わせて金額だけを返す。
   * 「取れなかった」のか「そもそも対象外」なのかまで知りたいときは
   * getRealShipping() を使うこと。
   */
  async getRealShippingCost(listingUrl: string): Promise<number | null> {
    return (await this.getRealShipping(listingUrl)).cost;
  }

  /**
   * 実送料を、取得状況と理由つきで返す。
   *
   * 取れるのは「メルカリ便で発送され、取引が完了した商品」だけ。
   * 普通郵便・定形外・発送方法未定・取引未完了・メルカリShops は仕様上取得できない
   * (発注仕様書 3-2 の「取得不可でよい」ケース)。
   *
   * 商品ページを1件ずつ開くので、呼び出し側で上位N件(標準=3件/詳細=20件)に絞ること。
   */
  async getRealShipping(listingUrl: string): Promise<RealShipping> {
    const id = listingUrl.split(/[?#]/)[0].split("/").filter(Boolean).pop();
    if (!id) {
      return { cost: null, status: "failed", method: null, ship_class: null, transaction_status: null, shipping_confirmed: false, reason: `商品URLを解釈できません: ${listingUrl}` };
    }
    if (isShopsItem(id)) {
      return {
        cost: null,
        status: "na",
        method: null,
        ship_class: null,
        transaction_status: null,
        shipping_confirmed: false,
        reason: "メルカリShopsは店舗が配送を手配するため、実送料が公開されていません",
      };
    }

    const detail = await this.getItemDetail(id);
    if (!detail) {
      return { cost: null, status: "failed", method: null, ship_class: null, transaction_status: null, shipping_confirmed: false, reason: "商品ページを読み取れませんでした" };
    }
    if (detail.shipping.cost === null) this.log(`  ${id}: ${detail.shipping.reason}`);
    else this.log(`  ${id}: ¥${detail.shipping.cost} (${detail.shipping.reason})`);
    return detail.shipping;
  }

  /**
   * 出品一覧のうち上位N件について実送料を取りに行き、結果を各出品に書き戻す。
   *
   * 取りに行く順番は「取引完了済みのSOLD」を先にする。実送料が確定しているのは
   * それだけなので、同じN件でも取得できる確率が上がる。
   * 対象にしなかった出品の ship_status は skip のまま残す。
   */
  async fillRealShipping(
    listings: DeepdiveListing[],
    topN: number,
    opts: { onProgress?: (done: number, total: number, r: RealShipping) => void } = {}
  ): Promise<{ got: number; fixed: number; failed: number; na: number }> {
    // 並び替えは「実送料が確定している見込みが高い順」。
    //   ① 一覧で発送済みと分かっているもの     … 確実に取れる
    //   ② それ以外                             … 一覧に取引情報が無いだけで、取れることが多い
    //   ③ 購入済みだがまだ発送されていないもの … 送料が確定していないので最後
    // 同順位の中では新しい順(fetchSellerで既に新しい順に並んでいる)を保つ。
    const priority = (l: DeepdiveListing) => (l.shipping_confirmed ? 0 : l.before_shipping ? 2 : 1);
    const targets = listings
      .filter((l) => l.status === "sold" && !l.is_shops)
      .sort((a, b) => priority(a) - priority(b))
      .slice(0, Math.max(0, topN));

    const tally = { got: 0, fixed: 0, failed: 0, na: 0 };
    if (!targets.length) {
      const sold = listings.filter((l) => l.status === "sold").length;
      this.log(
        topN <= 0
          ? "実送料は取得しません(取得件数が0に設定されています)"
          : sold === 0
            ? "実送料: 売れた出品が無いため取得対象がありません"
            : "実送料: メルカリShopsは店舗が配送を手配するため取得対象がありません"
      );
      return tally;
    }

    this.log(`実送料を取得します(SOLD上位${targets.length}件のみ)`);
    for (const [i, l] of targets.entries()) {
      let r: RealShipping;
      try {
        r = await this.getRealShipping(l.listing_url!);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        r = {
          cost: null,
          status: "failed",
          method: l.shipping_method ?? null,
          ship_class: null,
          transaction_status: null,
          shipping_confirmed: false,
          reason: `取得に失敗しました: ${String(e).slice(0, 80)}`,
        };
        this.log(`  ${l.external_id}: ${r.reason}`);
      }
      l.shipping_cost = r.cost;
      l.ship_status = r.status;
      l.ship_class = r.ship_class;
      // 商品ページで見た状態のほうが正確なので、一覧の目安を上書きする
      l.shipping_confirmed = r.shipping_confirmed;
      if (r.method) l.shipping_method = r.method;
      if (r.status !== "skip") tally[r.status]++;
      opts.onProgress?.(i + 1, targets.length, r);
    }
    this.log(
      `実送料: 取得${tally.got}件 / 一律${tally.fixed}件 / 取れず${tally.failed}件 / 対象外${tally.na}件`
    );
    return tally;
  }
}
