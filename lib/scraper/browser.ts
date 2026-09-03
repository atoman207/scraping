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

  /**
   * 仮想スクロールで遅延描画される一覧を、スクロールしながら少しずつ回収する。
   *
   * セラーページのように「もっと見る」を押さないと続きが出ない画面があるので、
   * スクロールしても新しい要素が増えなくなったら loadMoreText のボタンを探して押す。
   */
  async harvestWhileScrolling<T extends { id: string }>(
    extractor: () => T[],
    {
      maxScrolls = 16,
      stepPx = 1400,
      pauseMs = 600,
      stopAfter = Infinity,
      waitFor,
      loadMoreText = [],
      onProgress,
    }: {
      maxScrolls?: number;
      stepPx?: number;
      pauseMs?: number;
      stopAfter?: number;
      /** 回収を始める前に、この要素が現れるまで待つ */
      waitFor?: string;
      /** 増えなくなったときに押すボタンの文言(例: ["もっと見る"]) */
      loadMoreText?: string[];
      onProgress?: (count: number) => void;
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

    let stagnant = 0;
    for (let i = 0; i < maxScrolls && seen.size < stopAfter; i++) {
      const before = seen.size;
      await this.page.mouse.wheel(0, stepPx);
      await this.page.waitForTimeout(pauseMs);
      await collect();

      if (seen.size > before) {
        stagnant = 0;
        onProgress?.(seen.size);
        continue;
      }

      // 増えなくなった。「もっと見る」があれば押して続きを読み込む
      stagnant++;
      if (stagnant >= 2 && loadMoreText.length) {
        const clicked = await this.clickByText(loadMoreText);
        if (clicked) {
          await this.page.waitForTimeout(2500);
          await collect();
          stagnant = 0;
          onProgress?.(seen.size);
          continue;
        }
      }
      // ボタンも無く2回続けて増えないなら終端とみなす
      if (stagnant >= 3) break;
    }

    await collect();
    return [...seen.values()].slice(0, stopAfter === Infinity ? undefined : stopAfter);
  }

  /**
   * 指定の文言を含むボタン/リンクを押す。見つからなければ false。
   *
   * DOMの element.click() では React のハンドラが反応しないことがあるため、
   * Playwright の locator 経由(画面内までスクロールしてから実際のマウスイベント)で押す。
   */
  private async clickByText(texts: string[]): Promise<boolean> {
    if (!this.page) return false;
    for (const t of texts) {
      const loc = this.page
        .locator(`button:has-text("${t}"), a:has-text("${t}"), [role="button"]:has-text("${t}")`)
        .first();
      if ((await loc.count()) === 0) continue;
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
        await loc.click({ timeout: 8000 });
        return true;
      } catch {
        // 画面外/重なりで押せないときは強制クリックを試す
        try {
          await loc.click({ timeout: 5000, force: true });
          return true;
        } catch {
          /* 次の候補文言へ */
        }
      }
    }
    return false;
  }

  get currentPage(): Page {
    if (!this.page) throw new Error("start() を先に呼んでください");
    return this.page;
  }

  // ------------------------------------------------------------------
  // ページ自身が取得したJSONを読む仕組み
  //
  // メルカリの検索結果一覧はDOMに出品者が出ない。一方、画面を描画するために
  // ページ自身が内部APIを叩いており、そのレスポンスには出品者IDが含まれている。
  // ここでは「こちらからAPIを叩く」のではなく、**普通にページを開いた結果として
  // ブラウザが受け取ったレスポンスを読むだけ**。追加のリクエストは発生しないので、
  // サイトへの負荷はページを1枚開くのと変わらない。
  // ------------------------------------------------------------------

  /** URLパターン別に、直近で受け取ったJSONレスポンスを保持する */
  private captured = new Map<string, unknown[]>();
  private captureRules: { key: string; pattern: RegExp }[] = [];

  /**
   * 指定パターンのJSONレスポンスを捕捉するようにする。start() の後に呼ぶ。
   * 同じ key で複数回受け取った場合はすべて配列に貯まる。
   */
  captureJson(key: string, pattern: RegExp): void {
    if (!this.context) throw new Error("start() を先に呼んでください");
    if (this.captureRules.some((r) => r.key === key)) return;
    this.captureRules.push({ key, pattern });
    this.context.on("response", async (res) => {
      if (!pattern.test(res.url())) return;
      const ct = (res.headers()["content-type"] || "").split(";")[0];
      if (!ct.includes("json")) return;
      try {
        const body = await res.text();
        const arr = this.captured.get(key) ?? [];
        arr.push(JSON.parse(body));
        this.captured.set(key, arr);
      } catch {
        /* 途中で切れたレスポンスなどは黙って捨てる */
      }
    });
  }

  /** 捕捉済みのJSONを取り出して、そのkeyのバッファを空にする */
  takeCaptured<T = unknown>(key: string): T[] {
    const arr = (this.captured.get(key) ?? []) as T[];
    this.captured.set(key, []);
    return arr;
  }

  /** 捕捉済みバッファを空にする(次のページ遷移の前に呼ぶ) */
  clearCaptured(key?: string): void {
    if (key) this.captured.set(key, []);
    else this.captured.clear();
  }

  /**
   * 指定 key のJSONが最低1件届くまで待つ。届かなければ空配列を返す。
   * ページ遷移直後は描画とAPI取得にラグがあるため、固定sleepより確実。
   */
  async waitForCaptured<T = unknown>(key: string, timeoutMs = 20000, pollMs = 300): Promise<T[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const arr = this.captured.get(key);
      if (arr && arr.length) return this.takeCaptured<T>(key);
      await sleep(pollMs);
    }
    return [];
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
