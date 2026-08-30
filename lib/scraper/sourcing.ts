/**
 * 発注仕様書 3-3: AliExpress / 1688 連携。
 * 鉄板商品のタイトルから仕入れ候補を検索して提示する。
 *
 * AliExpress: 公開検索ページから候補を取得できる(実装済み)。
 * 1688      : 検索ページがログイン必須(login.taobao.com へリダイレクトされる)ため、
 *             スクレイピングはせず検索用ディープリンクを生成する。
 *             ログインを突破する実装は入れていない(下の doc コメント参照)。
 */
import { ScraperSession, type ScraperOptions } from "./browser";
import type { SourcingAdapter, SourcingCandidate } from "./types";

/** メルカリの日本語タイトルから、検索に効きそうな語だけ抜き出す */
export function toSearchQuery(title: string, maxTerms = 4): string {
  const cleaned = title
    .replace(/[【】《》〈〉「」『』\[\]（）()★☆♪＆&!！?？、。,・]/g, " ")
    .replace(/新品|未使用|送料無料|匿名配送|即購入|専用|セット|お得|人気|最安/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 全角スペース/半角スペース区切りの語を長い順に採用(短い助詞的な語を落とす)
  const terms = cleaned.split(/[\s　]+/).filter((t) => t.length >= 2);
  if (!terms.length) return cleaned.slice(0, 30);
  return terms.slice(0, maxTerms).join(" ");
}

function parseNpiPrices(href: string): { jpy: number | null; usd: number | null } {
  const m = href.match(/pdp_npi=([^&]+)/);
  if (!m) return { jpy: null, usd: null };
  const parts = decodeURIComponent(m[1]).split("!");
  // 例: 6@dis ! JPY ! 668 ! 161 ! ! ! 27.65 ! 6.66 ! @...
  const cur = parts[1];
  const saleLocal = Number(parts[3]);
  const saleUsd = Number(parts[7]);
  return {
    jpy: cur === "JPY" && Number.isFinite(saleLocal) ? saleLocal : null,
    usd: Number.isFinite(saleUsd) ? saleUsd : null,
  };
}

type RawAeCard = { id: string; href: string; alt: string | null; text: string };

function extractAeCards(): RawAeCard[] {
  const out: RawAeCard[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href*='/item/']"))) {
    const href = a.getAttribute("href") ?? "";
    const idm = href.match(/\/item\/(\d+)\.html/);
    if (!idm || seen.has(idm[1])) continue;
    seen.add(idm[1]);
    const card = (a.closest("div") ?? a) as HTMLElement;
    out.push({
      id: idm[1],
      href,
      alt: card.querySelector("img")?.getAttribute("alt") ?? null,
      text: (card.innerText ?? "").slice(0, 300),
    });
  }
  return out;
}

export class AliExpressSourcing implements SourcingAdapter {
  readonly platformName = "aliexpress";
  private session: ScraperSession;
  private log: (m: string) => void;

  /** @param jpyPerCny 円/元。深掘りリストの共通設定と同じ値を渡す */
  constructor(private jpyPerCny = 24, options: ScraperOptions = {}) {
    this.session = new ScraperSession(options);
    this.log = options.log ?? (() => {});
  }

  async start() {
    await this.session.start();
  }
  async close() {
    await this.session.close();
  }

  async searchCandidates(title: string, limit = 8): Promise<SourcingCandidate[]> {
    const q = toSearchQuery(title);
    const url = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(q).replace(/%20/g, "-")}.html`;
    this.log(`  AliExpress検索: "${q}"`);
    await this.session.goto(url, 6000);

    const cards = await this.session.harvestWhileScrolling<RawAeCard>(extractAeCards, {
      maxScrolls: 6,
      stopAfter: limit * 3,
    });

    const out: SourcingCandidate[] = [];
    for (const c of cards) {
      const { jpy, usd } = parseNpiPrices(c.href);
      // カードのテキストからも価格を拾う(npiが無い広告枠向けのフォールバック)
      const textJpy = c.text.match(/([\d,]+)\s*円/);
      const priceJpy = jpy ?? (textJpy ? Number(textJpy[1].replace(/,/g, "")) : null);
      const title2 = c.alt ?? c.text.split("\n")[0] ?? "";
      if (!title2) continue;
      out.push({
        source_platform: "aliexpress",
        title: title2.slice(0, 200),
        price: usd,
        currency: usd !== null ? "USD" : null,
        price_cny: priceJpy !== null ? Math.round((priceJpy / this.jpyPerCny) * 100) / 100 : null,
        url: "https:" + c.href.replace(/^https?:/, "").split("?")[0],
        image_url: null,
        min_order_qty: 1,
      });
      if (out.length >= limit) break;
    }
    this.log(`  → ${out.length}件の候補`);
    return out;
  }
}

/**
 * 1688 は検索ページ自体がログイン必須(未ログインだと login.taobao.com にリダイレクト)。
 * ログイン状態を偽装して突破する実装は入れていないため、ここでは
 * 「人が開けばそのまま使える検索URL」を組み立てて返す。
 * 深掘りリストの「仕入先URL」欄にそのまま貼れる形。
 */
export class Alibaba1688Sourcing implements SourcingAdapter {
  readonly platformName = "1688";

  async searchCandidates(title: string, _limit = 8): Promise<SourcingCandidate[]> {
    const q = toSearchQuery(title);
    return [
      {
        source_platform: "1688",
        title: `1688で「${q}」を検索(要ログイン・手動)`,
        price: null,
        currency: "CNY",
        price_cny: null,
        url: `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(q)}`,
        image_url: null,
        min_order_qty: null,
      },
      {
        source_platform: "1688",
        title: `1688の画像検索で「${q}」の類似品を探す`,
        price: null,
        currency: "CNY",
        price_cny: null,
        url: `https://www.1688.com/`,
        image_url: null,
        min_order_qty: null,
      },
    ];
  }
}
