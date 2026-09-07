/**
 * 発注仕様書 3-3: AliExpress / 1688 連携。
 * 鉄板商品の**タイトルと画像**から仕入れ候補を検索して提示する。
 *
 * ■ AliExpress
 *   ・タイトル検索: 公開の検索ページ(/w/wholesale-〜.html)をそのまま開いて読む。
 *   ・画像検索    : 検索窓のカメラアイコンにマウスを乗せると現れるファイル入力に
 *                   商品画像をアップロードする。人が画像検索を使うのと同じ操作で、
 *                   結果ページ(?isNewImageSearch=y)は通常の検索結果と同じ形。
 *   日本向け表示(locale=ja-JP)では価格が円で出るので、共通設定の為替で元に換算する。
 *
 * ■ 1688
 *   検索ページがログイン必須(未ログインだと login.taobao.com へ飛ばされる)。
 *   ログインを突破する実装は入れていないので、**人が開けばそのまま使える検索URL**
 *   (キーワード検索・画像検索)を組み立てて返すだけにしている。
 *
 * ■ やらないこと
 *   CAPTCHAの自動突破、ログインの偽装、断られたあとの再挑戦はしない
 *   (lib/scraper/browser.ts の方針と同じ)。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { ScraperSession, type ScraperOptions } from "./browser";
import { sequenceRatio } from "../engine/difflib";
import type { SourcingAdapter, SourcingCandidate } from "./types";

// ---------------------------------------------------------------- 検索語の組み立て

/** 検索の役に立たない、メルカリ側の売り文句 */
const NOISE_WORDS =
  /新品|未使用|未開封|送料無料|匿名配送|即購入可|即購入|即日発送|翌日発送|専用|セット|お得|人気|最安|限定|激安|大特価|値下げ|クーポン|フォロー割|まとめ買い|正規品|国内発送|訳あり|美品|中古/g;

/** タイトルに混ざる記号。検索語には要らないので空白にする */
const SYMBOLS = /[【】《》〈〉「」『』\[\]（）()★☆♪＆&!！?？、。,・|｜/／\\#＃@＠~〜]/g;

/**
 * メルカリの日本語タイトルから、検索に効きそうな語だけ抜き出す。
 *
 * タイトルには「新品未使用 送料無料 ★人気★」のような売り文句が混ざっていて、
 * そのまま投げると検索がぶれる。記号と売り文句を落として、長い語から採用する。
 * (長い語ほど商品そのものを指していることが多い)
 */
export function toSearchQuery(title: string, maxTerms = 4): string {
  const cleaned = title
    .replace(SYMBOLS, " ")
    .replace(NOISE_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();

  const terms = cleaned.split(/[\s　]+/).filter((t) => t.length >= 2);
  if (!terms.length) return (cleaned || title).slice(0, 30);

  // 長い語を優先して選び、並びは元のタイトル順に戻す(語順が意味を持つため)
  const picked = [...terms]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.length - a.t.length || a.i - b.i)
    .slice(0, maxTerms)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.t);
  return picked.join(" ").slice(0, 60);
}

/**
 * 元の商品タイトルと候補タイトルの一致度(0-100)。
 *
 * 文字の並びの近さ(difflib)だけだと、日本語では助詞や記号で点が入ってしまう。
 * 検索語に使った単語がいくつ含まれるかを主、文字列の近さを従にして混ぜる。
 */
export function scoreCandidate(sourceTitle: string, candidateTitle: string): number {
  if (!sourceTitle || !candidateTitle) return 0;
  const norm = (s: string) => s.toLowerCase().replace(/[\s　]+/g, "");
  const terms = toSearchQuery(sourceTitle, 6).split(" ").filter(Boolean);
  const target = norm(candidateTitle);
  const hit = terms.length ? terms.filter((t) => target.includes(norm(t))).length / terms.length : 0;
  const ratio = sequenceRatio(norm(sourceTitle), target);
  return Math.round((hit * 0.65 + ratio * 0.35) * 100);
}

// ---------------------------------------------------------------- カードの解析

/** 検索結果ページから1商品ぶん取り出した、加工前の値 */
export type RawAeCard = {
  id: string;
  href: string;
  alt: string | null;
  img: string | null;
  text: string;
};

/**
 * 検索結果ページのDOMから商品カードを取り出す(ブラウザ側で実行される)。
 *
 * AliExpressのカードはクラス名が頻繁に変わるので、**商品リンクを起点**にして
 * その親要素をカードとみなす。クラス名に依存しないぶん壊れにくい。
 */
export function extractAeCards(): RawAeCard[] {
  const out: RawAeCard[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href*='/item/']"))) {
    const href = a.getAttribute("href") ?? "";
    const idm = href.match(/\/item\/(\d+)\.html/);
    if (!idm || seen.has(idm[1])) continue;
    seen.add(idm[1]);
    const card = (a.closest("div") ?? a) as HTMLElement;

    // 遅延読み込み中の画像には共通のプレースホルダ(154x64.png)が入る。実物だけ拾う
    let img: string | null = null;
    let alt: string | null = null;
    for (const el of Array.from(card.querySelectorAll("img"))) {
      const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
      if (!alt) alt = el.getAttribute("alt") || null;
      if (src && src.indexOf("ae-pic") >= 0 && src.indexOf("154x64") < 0) {
        img = src;
        break;
      }
    }
    out.push({ id: idm[1], href, alt, img, text: (card.innerText ?? "").slice(0, 400) });
  }
  return out;
}

/** "1,234円" のような表記を数値にする */
function toNumber(s: string | undefined | null): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[,，\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** URLの正規化。プロトコル相対で返ってくるうえ、追跡用の長いクエリが付いている */
function normalizeItemUrl(href: string, id: string): string {
  const bare = href.split("?")[0].replace(/^https?:/, "");
  if (bare.startsWith("//")) return `https:${bare}`;
  if (bare.startsWith("/")) return `https://ja.aliexpress.com${bare}`;
  return bare || `https://ja.aliexpress.com/item/${id}.html`;
}

/** 画像URLの正規化(こちらもプロトコル相対) */
function normalizeImageUrl(src: string | null): string | null {
  if (!src) return null;
  if (src.startsWith("//")) return `https:${src}`;
  return src.startsWith("http") ? src : null;
}

/**
 * カードのテキストから価格・評価・販売数を読む。
 *
 * カードは次のような行の並びになっている(日本向け表示):
 *   商品名 / 173円 / 1,245円 / -86% / 4.8 / 500+ 点販売 / …
 * **1行まるごとが金額の行**だけを売値として採用する。
 * 「2点以上注文で1点あたり164円」「ご新規さま1,464円お得」のような
 * 条件付きの金額を売値と取り違えないため。
 */
export function parseAeCardText(text: string): {
  title: string | null;
  priceJpy: number | null;
  listPriceJpy: number | null;
  priceUsd: number | null;
  rating: number | null;
  orders: number | null;
  isAd: boolean;
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const prices: number[] = [];
  let priceUsd: number | null = null;
  let rating: number | null = null;
  let orders: number | null = null;

  for (const line of lines) {
    const jpy = line.match(/^[¥￥]?\s*([\d,]+)\s*円$/);
    if (jpy) {
      const n = toNumber(jpy[1]);
      if (n !== null) prices.push(n);
      continue;
    }
    const usd = line.match(/^US\s*\$\s*([\d.,]+)$/i);
    if (usd && priceUsd === null) {
      priceUsd = toNumber(usd[1]);
      continue;
    }
    const rate = line.match(/^([0-5](?:\.\d)?)$/);
    if (rate && rating === null) {
      rating = Number(rate[1]);
      continue;
    }
    const ord = line.match(/([\d,]+)\s*\+?\s*点(?:以上)?販売/);
    if (ord && orders === null) orders = toNumber(ord[1]);
  }

  return {
    title: lines[0] ?? null,
    // 最初の金額行が売値、2つ目があれば定価(取り消し線)
    priceJpy: prices[0] ?? null,
    listPriceJpy: prices[1] ?? null,
    priceUsd,
    rating,
    orders,
    isAd: lines.includes("広告"),
  };
}

// ---------------------------------------------------------------- 画像の取得

/** アップロードする画像の上限(バイト)。これを超える画像は扱わない */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * メルカリのサムネイルURLを、可能なら元画像のURLに読み替える。
 *
 * DBに入っているのは一覧用のサムネイル(webp・数KB)で、画像検索に使うには小さい。
 * メルカリは同じ商品IDで元画像(jpg)も公開しているので、そちらを先に試す。
 */
export function toOriginalMercariImage(url: string): string | null {
  const m = url.match(/static\.mercdn\.net\/thumb\/item\/(?:webp|jpeg|jpg)\/(m\d+)_(\d+)\.jpg/);
  if (!m) return null;
  return `https://static.mercdn.net/item/detail/orig/photos/${m[1]}_${m[2]}.jpg`;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const IMAGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 画像を1枚だけ一時ファイルに落とす。呼び出し側が必ず cleanup() すること */
export async function downloadImage(
  url: string
): Promise<{ file: string; bytes: number; cleanup: () => void }> {
  const res = await fetch(url, {
    headers: {
      // 画像の配信元がリファラを見ることがあるので、実際の参照元を名乗る
      "User-Agent": IMAGE_UA,
      Referer: "https://jp.mercari.com/",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`画像を取得できませんでした (HTTP ${res.status}): ${url}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error(`画像ではありませんでした (${type || "種類不明"}): ${url}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`画像が空でした: ${url}`);
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`画像が大きすぎます (${Math.round(buf.length / 1024)}KB): ${url}`);
  }

  const file = path.join(
    os.tmpdir(),
    `tenbai-sourcing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${EXT_BY_TYPE[type] ?? ".jpg"}`
  );
  fs.writeFileSync(file, buf);
  return {
    file,
    bytes: buf.length,
    cleanup: () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 消せなくても実害はない(OSの一時領域) */
      }
    },
  };
}

/**
 * 画像を落とす。メルカリのサムネイルなら、先に元画像(大きいほう)を試す。
 * 元画像が消えている商品もあるので、失敗したらサムネイルに戻る。
 */
export async function downloadProductImage(
  url: string,
  log: (m: string) => void = () => {}
): Promise<{ file: string; bytes: number; cleanup: () => void }> {
  const orig = toOriginalMercariImage(url);
  if (orig) {
    try {
      return await downloadImage(orig);
    } catch (e) {
      log(`  元画像を取れなかったのでサムネイルを使います (${String(e).slice(0, 80)})`);
    }
  }
  return await downloadImage(url);
}

// ---------------------------------------------------------------- AliExpress

/** 検索窓のカメラアイコン。マウスを乗せるとファイル入力が現れる */
const CAMERA_SELECTOR = "[class*='picture-search-btn'], [class*='picture-search-container'] img";
/** 検索結果の商品リンク。これが出るまでは「まだ描かれていない」 */
const ITEM_LINK_SELECTOR = "a[href*='/item/']";
/** 画像検索の結果ページかどうかを見分けるための印 */
const IMAGE_RESULT_MARK = "isNewImageSearch";

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

  /**
   * 同じブラウザ(同じレート制限)のまま別のページを開きたいときに使う。
   * 検証スクリプトが候補の商品ページを開いて突き合わせるために公開している。
   */
  get browserSession(): ScraperSession {
    return this.session;
  }

  /** 円 → 元。為替が0以下のときは換算しない(0で割らないため) */
  private toCny(jpy: number | null): number | null {
    if (jpy === null || !(this.jpyPerCny > 0)) return null;
    return Math.round((jpy / this.jpyPerCny) * 100) / 100;
  }

  private toCandidates(
    cards: RawAeCard[],
    opts: { mode: "title" | "image"; query: string; sourceTitle: string; limit: number }
  ): SourcingCandidate[] {
    const out: SourcingCandidate[] = [];
    for (const c of cards) {
      const parsed = parseAeCardText(c.text);
      const title = (c.alt || parsed.title || "").trim();
      if (!title) continue;

      const priceJpy = parsed.priceJpy;
      out.push({
        source_platform: "aliexpress",
        search_mode: opts.mode,
        query: opts.query,
        external_id: c.id,
        title: title.slice(0, 200),
        price: priceJpy ?? parsed.priceUsd,
        currency: priceJpy !== null ? "JPY" : parsed.priceUsd !== null ? "USD" : null,
        price_jpy: priceJpy,
        price_cny: this.toCny(priceJpy),
        url: normalizeItemUrl(c.href, c.id),
        image_url: normalizeImageUrl(c.img),
        // AliExpressは小売なので最小ロットは1個(1688は数十個からのことが多い)
        min_order_qty: 1,
        orders_count: parsed.orders,
        rating: parsed.rating,
        is_ad: parsed.isAd,
        match_score: scoreCandidate(opts.sourceTitle, title),
      });
      if (out.length >= opts.limit) break;
    }
    return out;
  }

  /**
   * いま開いている検索結果ページから商品カードを集める。
   *
   * 結果は遷移のあとに描画されるので、商品リンクが現れるまで待ってから読む。
   * それでも0件のときは、描画が間に合っていないことがあるので一度だけ待ち直す
   * (「本当に0件」と「まだ描かれていない」を取り違えると、候補が消える)。
   */
  private async harvest(limit: number): Promise<RawAeCard[]> {
    const options = { maxScrolls: 8, stopAfter: limit * 3 };
    // 「まだ描かれていない」を「0件」と取り違えると候補が消える。
    // 商品リンクが出るまで待ち、出なければ間を置いて2回まで読み直す。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await this.session.currentPage.waitForTimeout(4000);
      await this.session.waitForAny(ITEM_LINK_SELECTOR, 20000);
      const cards = await this.session
        .harvestWhileScrolling<RawAeCard>(extractAeCards, options)
        // ページが読み込み直された瞬間に読むと評価できないことがある。次の周回で取り直す
        .catch(() => [] as RawAeCard[]);
      if (cards.length) return cards;
    }
    // 0件のまま終わるときは、ページに何が出ていたかを残す。
    // 「本当に該当なし」なのか「別の画面(混雑・確認)が出ている」のかを後から切り分けるため。
    const hint = await this.session.currentPage
      .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 120))
      .catch(() => "");
    if (hint) this.log(`  商品が出ませんでした。ページの表示: ${hint}`);
    return [];
  }

  /**
   * 検索窓のカメラにマウスを乗せて、隠れているファイル入力を出す。
   *
   * 実際のマウス操作(hover)が届かないことがある(読み込み中に要素が動く・
   * アプリの案内が重なる)。そのときは force で押し込み、それでも駄目なら
   * mouseover をその要素に直接投げる。見つからなければ null を返す。
   */
  private async revealFileInput(page: Page): Promise<Locator | null> {
    if (!(await this.session.waitForAny(CAMERA_SELECTOR, 20000))) return null;
    const camera = page.locator(CAMERA_SELECTOR).first();
    const input = page.locator("input[type=file]").first();

    const attempts: (() => Promise<unknown>)[] = [
      () => camera.hover({ timeout: 8000 }),
      () => camera.hover({ timeout: 5000, force: true }),
      () => camera.dispatchEvent("mouseover"),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch {
        continue; // 次のやり方を試す
      }
      try {
        await input.waitFor({ state: "attached", timeout: 6000 });
        return input;
      } catch {
        /* まだ出ていない。次のやり方を試す */
      }
    }
    return null;
  }

  /** 商品タイトルから探す */
  async searchCandidates(title: string, limit = 12): Promise<SourcingCandidate[]> {
    const q = toSearchQuery(title);
    const url = `https://www.aliexpress.com/w/wholesale-${encodeURIComponent(q).replace(/%20/g, "-")}.html`;
    this.log(`  AliExpress タイトル検索: 「${q}」`);
    await this.session.goto(url, 6000);

    const cards = await this.harvest(limit);
    const out = this.toCandidates(cards, { mode: "title", query: q, sourceTitle: title, limit });
    this.log(`  → 候補${out.length}件(読み取り${cards.length}件)`);
    return out;
  }

  /**
   * 商品画像から類似商品を探す。
   *
   * 検索窓のカメラにマウスを乗せる → 現れたファイル入力に画像を渡す、という
   * 人が画像検索を使うときと同じ手順を踏む。結果ページに移らなかった場合は
   * **例外にせず空配列を返す**(タイトル検索の結果まで捨てないため)。
   */
  async searchByImage(imageUrl: string, limit = 12, sourceTitle = ""): Promise<SourcingCandidate[]> {
    let image: { file: string; bytes: number; cleanup: () => void };
    try {
      image = await downloadProductImage(imageUrl, this.log);
    } catch (e) {
      this.log(`  画像検索は行いません: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
      return [];
    }

    try {
      this.log(`  AliExpress 画像検索: ${Math.round(image.bytes / 1024)}KBの画像をアップロードします`);
      // トップページは ja.aliexpress.com に転送されたあとヘッダーを描き直すので、
      // 開いた直後にはカメラのアイコンがまだ無い(revealFileInput が待つ)
      const page = await this.session.goto("https://www.aliexpress.com/", 5000);

      const input = await this.revealFileInput(page);
      if (!input) {
        this.log("  画像の受け口が現れませんでした。タイトル検索の結果だけを使います。");
        return [];
      }
      await input.setInputFiles(image.file, { timeout: 20000 });

      // アップロード → 解析 → 結果ページへの遷移まで待つ(実測で3〜10秒)
      const deadline = Date.now() + 45000;
      let reached = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1500);
        if (page.url().includes(IMAGE_RESULT_MARK)) {
          reached = true;
          break;
        }
      }
      if (!reached) {
        this.log("  画像検索の結果ページに移りませんでした。タイトル検索の結果だけを使います。");
        return [];
      }
      const resultUrl = page.url();
      const cards = await this.harvest(limit);
      const out = this.toCandidates(cards, { mode: "image", query: resultUrl, sourceTitle, limit });
      this.log(`  → 候補${out.length}件(読み取り${cards.length}件)`);
      return out;
    } finally {
      image.cleanup();
    }
  }
}

// ---------------------------------------------------------------- 1688

/** 1688のキーワード検索URL(人が開く前提) */
export function keyword1688Url(q: string): string {
  return `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(q)}`;
}

/** 1688の画像検索ページ(人が画像をアップロードする前提) */
export const IMAGE_SEARCH_1688_URL = "https://s.1688.com/youyuan/index.htm?tab=imageSearch";

/**
 * 1688 は検索ページ自体がログイン必須(未ログインだと login.taobao.com にリダイレクトされる)。
 * ログイン状態を偽装して突破する実装は入れていないため、ここでは
 * 「人が開けばそのまま使える検索URL」を組み立てて返す。
 * 深掘りリストの「仕入先URL」欄にそのまま貼れる形になっている。
 */
export class Alibaba1688Sourcing implements SourcingAdapter {
  readonly platformName = "1688";

  async searchCandidates(title: string, _limit = 8): Promise<SourcingCandidate[]> {
    const q = toSearchQuery(title);
    return [this.link(`1688でキーワード「${q}」を検索する(要ログイン)`, keyword1688Url(q), q)];
  }

  /**
   * 1688の画像検索もログインが必要なので、画像検索ページのURLだけを返す。
   * (商品画像は人が貼り直す前提。こちらから自動でアップロードはしない)
   */
  async searchByImage(imageUrl: string, _limit = 8): Promise<SourcingCandidate[]> {
    return [
      this.link(
        "1688の画像検索を開く(この商品画像をアップロードして類似品を探す・要ログイン)",
        IMAGE_SEARCH_1688_URL,
        imageUrl
      ),
    ];
  }

  private link(title: string, url: string, query: string): SourcingCandidate {
    return {
      source_platform: "1688",
      search_mode: "link",
      query,
      external_id: null,
      title,
      price: null,
      currency: "CNY",
      price_jpy: null,
      price_cny: null,
      url,
      image_url: null,
      min_order_qty: null,
      orders_count: null,
      rating: null,
      is_ad: false,
      match_score: null,
    };
  }
}
