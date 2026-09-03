/**
 * 発注仕様書 3-1 / 3-2 のメルカリ実装。
 *
 * 取得元はすべて **ログイン不要の公開ページ** で、Playwrightの実ブラウザでそのまま開いて
 * レンダリング後のDOMを読む。非公開の内部APIやトークンには触れていない。
 *
 * 実際のDOM構造(2026-08時点で確認):
 *   一覧セル : li[data-testid="item-cell"]
 *              └ [role="img"][id="<商品ID>"][aria-label="<タイトル>の画像 [売り切れ ]<価格>円"]
 *              └ [data-testid="thumbnail-sticker"][aria-label="売り切れ"]   ← SOLD判定
 *   検索     : /search?keyword=...&status=sold_out&page_token=v1:N
 *   セラー   : /user/profile/<セラーID>
 *   商品     : /item/<商品ID>            (メルカリShopsは /shops/product/<商品ID>)
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
  BlockedError,
  type ScrapedListing,
  type ScrapedSeller,
  type SellerDeepdiveAdapter,
  type SellerResearchAdapter,
} from "./types";

/** ページ自身が受け取るレスポンスを捕捉するときのキー */
const CAPTURE_SEARCH = "search";
const CAPTURE_SHIPPING = "shippingMethods";

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
  /** 相対表記("7時間前")から起こした概算の出品日 */
  listed_at: string | null;
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
   * @param keyword     検索キーワード
   * @param aruaruWords 「あるあるワード」。指定すると keyword と組み合わせて個別に検索する
   * @param maxPages    1クエリあたり読むページ数(目安10)
   */
  async searchSold(
    keyword: string,
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
    // あるあるワードは絞り込み用。指定があればキーワードと組み合わせて個別に検索する
    const queries = aruaruWords.length ? aruaruWords.map((w) => `${keyword} ${w}`.trim()) : [keyword];

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
  /** 発注仕様書 3-2: 指定セラーの出品一覧を新しい順に最大 maxItems 件取得 */
  async getSellerListings(sellerExternalId: string, maxItems = 100): Promise<ScrapedListing[]> {
    const profile = await this.getSellerProfile(sellerExternalId);
    const sellerName = profile?.seller_name ?? sellerExternalId;

    this.log(`セラー ${sellerExternalId} (${sellerName}) の出品一覧を取得します(最大${maxItems}件)`);
    await this.session.goto(this.profileUrl(sellerExternalId));
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
    this.log(`  → ${cells.length}件の出品を取得`);

    const listings: ScrapedListing[] = [];
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
      });
    }
    this.log(`  → SOLD ${listings.filter((l) => l.status === "sold").length}件 / 販売中 ${listings.filter((l) => l.status === "active").length}件`);
    return listings;
  }

  /** セラーIDからプロフィールURLを組み立てる("shops:" 付きはメルカリShops) */
  profileUrl(sellerExternalId: string): string {
    return sellerExternalId.startsWith("shops:")
      ? `${ORIGIN}/shops/profile/${encodeURIComponent(sellerExternalId.slice(6))}`
      : `${ORIGIN}/user/profile/${encodeURIComponent(sellerExternalId)}`;
  }

  /** セラーのプロフィール(名前・評価数)を取得 */
  async getSellerProfile(sellerExternalId: string): Promise<ScrapedSeller | null> {
    const url = this.profileUrl(sellerExternalId);
    await this.session.goto(url);
    // 名前が描画されるまで待つ。固定待ちだと、まだ出ていないパンくず(「ホーム」)を
    // 名前と誤認することがあるため。
    await this.session.waitForAny("h1", 12000);
    const page = this.session.currentPage;

    const info = await page.evaluate(() => {
      const text = document.body.innerText;
      // 「101」のような評価数は名前のすぐ下、「本人確認済」の手前に出る
      const ratingCount = text.match(/(\d[\d,]*)\s*\n\s*(本人確認済|フォロー)/);
      const listingCount = text.match(/(\d[\d,]*)\s*出品数/);
      return {
        title: document.title,
        h1: document.querySelector("h1")?.textContent?.trim() ?? null,
        head: text.slice(0, 300),
        ratingCount: ratingCount ? ratingCount[1] : null,
        listingCount: listingCount ? listingCount[1] : null,
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
    return {
      platform: PLATFORM,
      seller_external_id: sellerExternalId,
      seller_name: name,
      rating: null, // メルカリは★数値ではなく良い/悪い評価件数のみ公開
      review_count: info.ratingCount ? Number(info.ratingCount.replace(/,/g, "")) : null,
      profile_url: url,
    };
  }

  /** 商品ページから詳細(出品者・配送方法など)を読む */
  async getItemDetail(externalId: string): Promise<ItemDetail | null> {
    const url = itemUrl(externalId);
    const page = await this.session.goto(url, 500);

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

    return {
      external_id: externalId,
      title: d.title,
      price: Number.isFinite(price) ? price : null,
      sold: d.sold,
      seller_external_id: sellerId,
      seller_name: sellerName,
      shipping_method: d.shippingMethod,
      shipping_cost: shippingCostFromMethod(d.shippingMethod),
      condition: d.condition,
      is_new: d.condition ? d.condition.includes("新品") : null,
      listed_at: relTime ? relativeJaToDate(relTime[0]) : null,
    };
  }

  /**
   * 発注仕様書 3-2: 取引完了済みの商品ページから実送料を取得する。
   * 配送方法名からサイズまで一意に決まる場合のみ金額を返し、
   * 「らくらくメルカリ便」だけ・普通郵便・定形外・取引未完了などは null。
   */
  async getRealShippingCost(listingUrl: string): Promise<number | null> {
    const id = listingUrl.split("/").filter(Boolean).pop();
    if (!id) return null;
    const detail = await this.getItemDetail(id);
    if (!detail) return null;
    if (!detail.sold) {
      this.log(`  ${id}: 取引未完了のため実送料は取得しません`);
      return null;
    }
    if (detail.shipping_cost === null) {
      this.log(`  ${id}: 配送方法「${detail.shipping_method ?? "不明"}」からは金額を特定できません`);
    }
    return detail.shipping_cost;
  }
}
