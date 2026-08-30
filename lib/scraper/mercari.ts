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
  BlockedError,
  type ScrapedListing,
  type ScrapedSeller,
  type SellerDeepdiveAdapter,
  type SellerResearchAdapter,
} from "./types";

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
  /** 相対表記("7時間前")から起こした概算の出品日 */
  listed_at: string | null;
};

export class MercariScraper implements SellerResearchAdapter, SellerDeepdiveAdapter {
  readonly platformName = PLATFORM;
  private session: ScraperSession;
  private log: (m: string) => void;

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
   * 検索結果の一覧には出品者情報が含まれていないため、セラーを確定するには
   * 商品ページを個別に開く必要がある。全件開くとアクセス回数が跳ね上がるので、
   * resolveSellerLimit 件(既定30件)だけ解決する。呼び出し側で調整可能。
   */
  async searchSold(
    keyword: string,
    aruaruWords: string[] = [],
    maxPages = 10,
    opts: { resolveSellerLimit?: number } = {}
  ): Promise<(ScrapedListing & { matched_keyword: string })[]> {
    const resolveLimit = opts.resolveSellerLimit ?? 30;
    // あるあるワードは絞り込み用。指定があればキーワードと組み合わせて個別に検索する
    const queries = aruaruWords.length ? aruaruWords.map((w) => `${keyword} ${w}`.trim()) : [keyword];

    const collected = new Map<string, RawCell & { matched: string }>();
    for (const q of queries) {
      for (let p = 0; p < maxPages; p++) {
        const url =
          `${ORIGIN}/search?keyword=${encodeURIComponent(q)}&status=sold_out` +
          (p > 0 ? `&page_token=${encodeURIComponent(`v1:${p}`)}` : "");
        this.log(`  検索: "${q}" ${p + 1}/${maxPages}ページ目`);
        await this.session.goto(url, 4000);
        let cells = await this.session.harvestWhileScrolling<RawCell>(extractCells, {
          maxScrolls: 16,
          waitFor: CELL_SELECTOR,
        });
        if (cells.length === 0) {
          // 描画が間に合っていないだけのことがあるので、一度だけ待ち直す
          this.log(`  → 0件。描画待ちで再試行します`);
          await this.session.currentPage.waitForTimeout(6000);
          cells = await this.session.harvestWhileScrolling<RawCell>(extractCells, {
            maxScrolls: 16,
            waitFor: CELL_SELECTOR,
          });
        }
        if (cells.length === 0) {
          this.log(`  → 0件。これ以上ページがないと判断して打ち切ります`);
          break;
        }
        let added = 0;
        for (const c of cells) {
          if (!collected.has(c.id)) {
            collected.set(c.id, { ...c, matched: q });
            added++;
          }
        }
        this.log(`  → ${cells.length}件取得(新規${added}件, 累計${collected.size}件)`);
        if (added === 0) break; // 同じ内容が返り始めたら終端
      }
    }

    // SOLD のものだけを対象にする(status=sold_out でも稀に混ざるため念のため絞る)
    const sold = [...collected.values()].filter((c) => {
      const p = parseAria(c.aria);
      return p?.sold ?? c.sticker === "売り切れ";
    });
    this.log(`検索完了: ${collected.size}件中 SOLD ${sold.length}件`);

    // 出品者を解決する(商品ページを開く必要があるので上位N件のみ)
    const targets = sold.slice(0, resolveLimit);
    this.log(`出品者の解決: 上位${targets.length}件の商品ページを開きます`);

    const results: (ScrapedListing & { matched_keyword: string })[] = [];
    let failed = 0;
    for (const [i, c] of targets.entries()) {
      const parsed = parseAria(c.aria);
      if (!parsed) {
        failed++;
        continue;
      }
      let detail: ItemDetail | null = null;
      try {
        detail = await this.getItemDetail(c.id);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        failed++;
        this.log(`  [${i + 1}/${targets.length}] ${c.id} 取得失敗: ${String(e).slice(0, 90)}`);
        continue;
      }
      if (!detail?.seller_external_id) {
        failed++;
        continue;
      }
      results.push({
        platform: PLATFORM,
        external_id: c.id,
        seller_external_id: detail.seller_external_id,
        seller_name: detail.seller_name ?? detail.seller_external_id,
        title: parsed.title,
        price: parsed.price,
        status: "sold",
        listed_at: detail.listed_at,
        sold_at: null, // 公開ページに売却日時は出ないため取得不可
        shipping_method: detail.shipping_method,
        shipping_cost: detail.shipping_cost,
        image_url: c.img,
        listing_url: itemUrl(c.id),
        matched_keyword: c.matched,
      });
      if ((i + 1) % 5 === 0) this.log(`  [${i + 1}/${targets.length}] 解決済み ${results.length}件`);
    }
    this.log(`出品者の解決: 成功${results.length}件 / 失敗${failed}件`);
    return results;
  }

  // ---------------------------------------------------------------- 3-2
  /** 発注仕様書 3-2: 指定セラーの出品一覧を新しい順に最大 maxItems 件取得 */
  async getSellerListings(sellerExternalId: string, maxItems = 100): Promise<ScrapedListing[]> {
    const profile = await this.getSellerProfile(sellerExternalId);
    const sellerName = profile?.seller_name ?? sellerExternalId;

    this.log(`セラー ${sellerExternalId} (${sellerName}) の出品一覧を取得します(最大${maxItems}件)`);
    await this.session.goto(this.profileUrl(sellerExternalId));
    const cells = await this.session.harvestWhileScrolling<RawCell>(extractCells, {
      maxScrolls: Math.max(20, Math.ceil(maxItems / 4)),
      stopAfter: maxItems,
      waitFor: CELL_SELECTOR,
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
    const page = await this.session.goto(url);
    const info = await page.evaluate(() => {
      const text = document.body.innerText;
      // 「101」のような評価数は名前のすぐ下、「本人確認済」の手前に出る
      const ratingCount = text.match(/(\d[\d,]*)\s*\n\s*(本人確認済|フォロー)/);
      const listingCount = text.match(/(\d[\d,]*)\s*出品数/);
      return {
        title: document.title,
        head: text.slice(0, 300),
        ratingCount: ratingCount ? ratingCount[1] : null,
        listingCount: listingCount ? listingCount[1] : null,
      };
    });

    // ページタイトルが「<名前>さんのプロフィール | メルカリ」形式なのでそこから取る
    const fromTitle =
      info.title.match(/^(.+?)さんのプロフィール/)?.[1]?.trim() ??
      info.title.match(/^(.+?)s*[|-]s*メルカリ/)?.[1]?.trim() ??
      null;
    // フォールバック: 本文先頭の、共通ナビ以外の最初の行
    const NAV = ["コンテンツにスキップ", "ログイン", "会員登録", "出品", "日本語", "プロフィール"];
    const firstLine = info.head
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .find((s) => !NAV.includes(s) && !/^\d[\d,]*$/.test(s));
    const name = fromTitle || firstLine || null;
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
    const page = await this.session.goto(url, 3000);

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
