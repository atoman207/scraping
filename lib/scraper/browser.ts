/**
 * スクレイパー共通基盤(Playwright版)。
 * 元の scraper/base.py の RateLimitedSession を、ヘッドレスブラウザ前提に置き換えたもの。
 *
 * 方針:
 *  - 実ブラウザ(Chromium)で公開ページをそのまま開く。JSレンダリング後のDOMを読む。
 *  - アクセス間隔を必ず空ける(既定2.5秒 + ゆらぎ)。同時実行はしない。
 *  - ブロックされたら黙って回避を試みるのではなく、BlockedError を投げて呼び出し側に止めさせる。
 *  - 日本語ロケール/東京タイムゾーンを指定するのは、日本向けの検索結果と価格表記を
 *    正しく得るために必要な設定(表示条件を合わせるためのもの)。
 */
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { BlockedError } from "./types";

export type ScraperOptions = {
  /** ページ遷移の最小間隔(ミリ秒)。既定2500ms */
  minIntervalMs?: number;
  /** 間隔に足すランダムなゆらぎの上限(ミリ秒)。既定1200ms */
  jitterMs?: number;
  /** ヘッドレスで動かすか。既定true。false にすると実際の画面が見える */
  headless?: boolean;
  /** ナビゲーションのタイムアウト(ミリ秒)。既定45000ms */
  navigationTimeoutMs?: number;
  /** 進捗ログの出力先 */
  log?: (msg: string) => void;
};

const DEFAULTS = {
  minIntervalMs: 2500,
  jitterMs: 1200,
  headless: true,
  navigationTimeoutMs: 45000,
};

/** ブロック判定に使う文言。出たら即座に中断する */
const BLOCK_MARKERS = [
  "アクセスが集中しています",
  "しばらく時間をおいて",
  "Access Denied",
  "Request blocked",
  "unusual traffic",
  "reCAPTCHA",
  "認証が必要です",
  "ロボットではないこと",
];

export class ScraperSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastNavigation = 0;
  readonly opts: Required<Omit<ScraperOptions, "log">> & { log: (m: string) => void };

  constructor(options: ScraperOptions = {}) {
    this.opts = {
      minIntervalMs: options.minIntervalMs ?? DEFAULTS.minIntervalMs,
      jitterMs: options.jitterMs ?? DEFAULTS.jitterMs,
      headless: options.headless ?? DEFAULTS.headless,
      navigationTimeoutMs: options.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs,
      log: options.log ?? (() => {}),
    };
  }

  async start(): Promise<void> {
    if (this.browser) return;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: this.opts.headless });
    this.context = await this.browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1280, height: 900 },
    });
    this.context.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs);
    // 画像/フォント/広告系は取得しない。転送量とサイト側の負荷を減らすため
    await this.context.route("**/*", (route) => {
      const t = route.request().resourceType();
      const u = route.request().url();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      if (/googletagmanager|google-analytics|doubleclick|adsense|criteo|tr\.line\.me|facebook/.test(u)) {
        return route.abort();
      }
      return route.continue();
    });
    // tsx/esbuild は関数に __name() ラッパを付けることがある。page.evaluate に渡した
    // 関数がブラウザ側で ReferenceError にならないよう、先に空の実装を入れておく。
    await this.context.addInitScript(() => {
      // @ts-expect-error ブラウザ側グローバルへの注入
      if (typeof window.__name === "undefined") window.__name = (fn: unknown) => fn;
    });
    this.page = await this.context.newPage();
    this.opts.log(`ブラウザ起動 (headless=${this.opts.headless}, 間隔=${this.opts.minIntervalMs}ms+ゆらぎ)`);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  private async throttle(): Promise<void> {
    const wait = this.opts.minIntervalMs + Math.random() * this.opts.jitterMs;
    const elapsed = Date.now() - this.lastNavigation;
    if (elapsed < wait) await sleep(wait - elapsed);
    this.lastNavigation = Date.now();
  }

  /** レート制限つきでページを開く。ブロックされたら BlockedError を投げる */
  async goto(url: string, settleMs = 3500): Promise<Page> {
    if (!this.page) throw new Error("start() を先に呼んでください");
    await this.throttle();

    let resp: Response | null = null;
    try {
      resp = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      throw new Error(`ページを開けませんでした: ${url} (${String(e).slice(0, 200)})`);
    }

    const status = resp?.status() ?? 0;
    if (status === 403 || status === 429 || status === 503) {
      throw new BlockedError(
        `サイト側にアクセスを拒否されました (HTTP ${status})。間隔を空けて時間をおいてください。`,
        url,
        status
      );
    }
    if (status >= 400) {
      throw new Error(`HTTP ${status}: ${url}`);
    }

    await this.page.waitForTimeout(settleMs);

    const body = await this.page.locator("body").innerText().catch(() => "");
    const hit = BLOCK_MARKERS.find((m) => body.includes(m));
    if (hit && body.length < 2000) {
      throw new BlockedError(`ブロックページが返されました(「${hit}」を検出)。`, url, status);
    }
    return this.page;
  }

  /**
   * 指定のセレクタが現れるまで待つ。現れなければ false を返す(例外にはしない)。
   * 固定のsleepより確実なので、一覧の描画待ちはこちらを使う。
   */
  async waitForAny(selector: string, timeoutMs = 15000): Promise<boolean> {
    if (!this.page) throw new Error("start() を先に呼んでください");
    try {
      await this.page.waitForSelector(selector, { timeout: timeoutMs, state: "attached" });
      return true;
    } catch {
      return false;
    }
  }

  /** 仮想スクロールで遅延描画される一覧を、スクロールしながら少しずつ回収する */
  async harvestWhileScrolling<T extends { id: string }>(
    extractor: () => T[],
    { maxScrolls = 16, stepPx = 1400, pauseMs = 600, stopAfter = Infinity, waitFor }: {
      maxScrolls?: number;
      stepPx?: number;
      pauseMs?: number;
      stopAfter?: number;
      /** 回収を始める前に、この要素が現れるまで待つ */
      waitFor?: string;
    } = {}
  ): Promise<T[]> {
    if (!this.page) throw new Error("start() を先に呼んでください");
    if (waitFor) await this.waitForAny(waitFor);
    const seen = new Map<string, T>();
    const collect = async () => {
      for (const item of await this.page!.evaluate(extractor)) {
        if (item.id && !seen.has(item.id)) seen.set(item.id, item);
      }
    };
    await collect();
    for (let i = 0; i < maxScrolls && seen.size < stopAfter; i++) {
      await this.page.mouse.wheel(0, stepPx);
      await this.page.waitForTimeout(pauseMs);
      await collect();
    }
    await collect();
    return [...seen.values()].slice(0, stopAfter === Infinity ? undefined : stopAfter);
  }

  get currentPage(): Page {
    if (!this.page) throw new Error("start() を先に呼んでください");
    return this.page;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * メルカリの「7時間前」「3日前」「2ヶ月前」といった相対表記を
 * YYYY-MM-DD の絶対日付に変換する。変換できなければ null。
 */
export function relativeJaToDate(text: string, now = new Date()): string | null {
  const m = text.match(/(\d+)\s*(秒|分|時間|日|ヶ月|か月|カ月|年)前/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const d = new Date(now.getTime());
  if (unit === "秒") d.setSeconds(d.getSeconds() - n);
  else if (unit === "分") d.setMinutes(d.getMinutes() - n);
  else if (unit === "時間") d.setHours(d.getHours() - n);
  else if (unit === "日") d.setDate(d.getDate() - n);
  else if (unit === "年") d.setFullYear(d.getFullYear() - n);
  else d.setMonth(d.getMonth() - n); // ヶ月/か月/カ月
  return d.toISOString().slice(0, 10);
}
