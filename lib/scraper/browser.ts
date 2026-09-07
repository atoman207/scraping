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
 *
 * 「普通のブラウザとして名乗る」ことと「ブロックを回避する」ことの線引き:
 *   前者はやる。ヘッドレスChromiumは既定で「HeadlessChrome」と名乗り、
 *   navigator.webdriver=true を立てるため、通常のページが配信されず
 *   中身の無いページが返ってくる。これは取得の失敗であって、直すべき不具合。
 *   後者はやらない。断られた(403/429/503・ブロックページ)ら即座に止める。
 *   CAPTCHAの自動突破、プロキシの切り替え、指紋の偽装、断られた後の再挑戦は
 *   いずれも実装していない。
 */
import type { Browser, BrowserContext, BrowserType, LaunchOptions, Page, Response } from "playwright";
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
  /** 通信の一時的な失敗をやり直す回数。既定2回(ブロックはやり直さない) */
  retries?: number;
  /** 進捗ログの出力先 */
  log?: (msg: string) => void;
};

const DEFAULTS = {
  minIntervalMs: 2500,
  jitterMs: 1200,
  headless: true,
  navigationTimeoutMs: 45000,
  retries: 2,
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

/**
 * ブラウザが用意されていないときのエラーかどうか。
 *
 * Playwright は npm install だけではブラウザ本体を持ってこない。
 * `npx playwright install chromium` を1回実行して、ms-playwright フォルダに
 * 置いたものを使う。入っていないと launch() が
 * 「Executable doesn't exist at ...」という英語のエラーで落ちる。
 */
function isMissingBrowserError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("Executable doesn't exist") ||
    msg.includes("playwright install") ||
    msg.includes("Please run the following command")
  );
}

/**
 * Chromium を起動する。本体が入っていない場合の受け身も持たせてある。
 *
 * ■ なぜこの処理が要るのか
 *   Playwright付属のChromiumは `npx playwright install chromium` で入る別物で、
 *   npm install では入らない。VPSを作り直したときや、ユーザープロファイルごと
 *   消えたときに無くなる。そのまま落とすと、画面には英語のスタックトレースだけが
 *   出て、運用する人には何をすればいいのか分からない。
 *
 * ■ どう受けるか
 *   ① まずPlaywright付属のChromiumで起動する(通常はここで成功する)
 *   ② 無ければ、このPCにインストール済みの Chrome / Edge を借りて動かす。
 *      黙って代替すると原因が埋もれるので、必ずログに残して直し方も出す。
 *   ③ どれも無ければ、日本語で直し方を書いた例外にして止める。
 */
async function launchChromium(
  chromium: BrowserType,
  options: LaunchOptions,
  log: (msg: string) => void
): Promise<Browser> {
  try {
    return await chromium.launch(options);
  } catch (e) {
    if (!isMissingBrowserError(e)) throw e;

    // このPCに入っている普通のブラウザで代替できないか試す
    for (const channel of ["chrome", "msedge"] as const) {
      try {
        const browser = await chromium.launch({ ...options, channel });
        log(
          `Playwright付属のChromiumが見つからないため、インストール済みの ${channel} で代替します。` +
            " 本来のブラウザを入れるには ops\\install-browser.cmd を実行してください。"
        );
        return browser;
      } catch {
        // この端末には無い。次の候補へ
      }
    }

    throw new Error(
      "ブラウザ(Chromium)が用意されていません。" +
        "ops\\install-browser.cmd を実行するか、プロジェクトのフォルダで " +
        "`npx playwright install chromium` を1回だけ実行してください。" +
        "(npm install ではブラウザ本体は入りません)"
    );
  }
}

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
      retries: options.retries ?? DEFAULTS.retries,
      log: options.log ?? (() => {}),
    };
  }

  async start(): Promise<void> {
    if (this.browser) return;
    const { chromium } = await import("playwright");
    this.browser = await launchChromium(
      chromium,
      {
        headless: this.opts.headless,
        // Playwright既定のヘッドレスChromiumは、自分がヘッドレスであることを
        // User-Agent(「HeadlessChrome/…」)と navigator.webdriver で自己申告する。
        // その状態だと通常のページが配信されず、簡易版や案内ページが返ってきて
        // 「取得できているのに中身が空」という切り分けづらい失敗になる。
        // ここでやっているのは **普通のChromeとして名乗る** ことだけで、
        // アクセス頻度を上げたり、ブロックを回避して押し通したりはしない
        // (403等を受け取ったら goto() が BlockedError で止める方針は変えていない)。
        args: ["--disable-blink-features=AutomationControlled", "--lang=ja-JP"],
      },
      this.opts.log
    );
    this.context = await this.browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1440, height: 960 },
      // 実際のChromeと同じ体裁にする。バージョンは実行中のChromiumに合わせる
      userAgent: chromeUserAgent(this.browser.version()),
      extraHTTPHeaders: { "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7" },
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
      // 自動操作中であることを示すフラグ。付いたままだと通常のページが配信されず、
      // 中身の無いページが返ってくることがある(上の launch args と同じ理由)
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      } catch {
        /* 既に定義されていて上書きできない環境ではそのままでよい */
      }
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

  /**
   * レート制限つきでページを開く。ブロックされたら BlockedError を投げる。
   *
   * 通信の瞬断やタイムアウトは、待ち時間を伸ばしながら数回だけやり直す。
   * ただし **ブロック(403/429/503・ブロックページ)は絶対にやり直さない**。
   * 断られているのに繰り返し叩くのは、相手にとっても迷惑で、こちらの状況も悪化させるため。
   */
  async goto(url: string, settleMs = 3500): Promise<Page> {
    if (!this.page) throw new Error("start() を先に呼んでください");

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (attempt > 0) {
        // 2回目以降は間隔を倍々にして待つ(2.5秒 → 5秒 → 10秒 …)
        const backoff = this.opts.minIntervalMs * 2 ** attempt;
        this.opts.log(`  再試行 ${attempt}/${this.opts.retries}: ${Math.round(backoff / 1000)}秒待ちます`);
        await sleep(backoff);
      }
      await this.throttle();

      let resp: Response | null = null;
      try {
        resp = await this.page.goto(url, { waitUntil: "domcontentloaded" });
      } catch (e) {
        // ナビゲーション自体の失敗(タイムアウト・接続断)はやり直す価値がある
        lastError = new Error(`ページを開けませんでした: ${url} (${String(e).slice(0, 200)})`);
        continue;
      }

      const status = resp?.status() ?? 0;
      if (status === 403 || status === 429 || status === 503) {
        throw new BlockedError(
          `サイト側にアクセスを拒否されました (HTTP ${status})。間隔を空けて時間をおいてください。`,
          url,
          status
        );
      }
      if (status === 404 || status === 410) {
        // 消された商品・存在しないセラー。やり直しても結果は変わらない
        throw new Error(`ページが見つかりません (HTTP ${status}): ${url}`);
      }
      if (status >= 400) {
        lastError = new Error(`HTTP ${status}: ${url}`);
        continue;
      }

      await this.page.waitForTimeout(settleMs);

      const body = await this.page.locator("body").innerText().catch(() => "");
      const hit = BLOCK_MARKERS.find((m) => body.includes(m));
      if (hit && body.length < 2000) {
        throw new BlockedError(`ブロックページが返されました(「${hit}」を検出)。`, url, status);
      }
      return this.page;
    }
    throw lastError ?? new Error(`ページを開けませんでした: ${url}`);
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
  async clickByText(texts: string[]): Promise<boolean> {
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

  /**
   * 一覧の「続き」を読み込ませて、そのとき届いたJSONレスポンスを返す。
   *
   * 画面を下へスクロールする(=利用者と同じ操作)と、ページ自身が次の30件を取りに行く。
   * スクロールで反応しない画面では「もっと見る」ボタンを押す。
   * どちらでも新しいレスポンスが来なければ空配列を返すので、呼び出し側が終端と判断できる。
   *
   * ページ遷移ではないので goto() のレート制限はかからない。代わりに、
   * 追加読み込みを短時間に連打しないよう pauseMs 以上の間隔を必ず空ける。
   */
  async loadMoreCaptured<T = unknown>(
    key: string,
    {
      stepPx = 2400,
      pauseMs = 1200,
      timeoutMs = 8000,
      loadMoreText = ["もっと見る", "さらに表示"],
    }: { stepPx?: number; pauseMs?: number; timeoutMs?: number; loadMoreText?: string[] } = {}
  ): Promise<T[]> {
    if (!this.page) throw new Error("start() を先に呼んでください");
    this.clearCaptured(key);

    await this.page.mouse.wheel(0, stepPx);
    await this.page.waitForTimeout(pauseMs);
    const scrolled = await this.waitForCaptured<T>(key, timeoutMs);
    if (scrolled.length) return scrolled;

    if (loadMoreText.length && (await this.clickByText(loadMoreText))) {
      await this.page.waitForTimeout(pauseMs);
      return await this.waitForCaptured<T>(key, timeoutMs);
    }
    return [];
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
 * 実行中のChromiumのバージョンから、通常のChromeと同じUser-Agentを組み立てる。
 *
 * Playwright既定のUAは "HeadlessChrome/<version>" になっていて、
 * これが入っているとサイト側が通常のページを返さないことがある。
 * バージョン番号は実物に合わせるので、嘘の値を名乗ることにはならない。
 */
export function chromeUserAgent(browserVersion: string): string {
  // browserVersion は "151.0.7922.34" のような形。取れなければ広く使われている値にする
  const v = /^\d+\.\d+\.\d+\.\d+$/.test(browserVersion) ? browserVersion : "131.0.0.0";
  return (
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${v} Safari/537.36`
  );
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
