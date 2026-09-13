/**
 * 1688Japan(pro.1688japan.com)に手でログインして、セッションを保存する。
 *   npm run login:1688jp
 *
 * ■ なぜ手でログインするのか
 *   ログイン画面に4桁の確認コード(画像認証)があるため、自動ではログインできない。
 *   自動で突破することもしない(README のスクレイパー方針と同じ)。
 *   代わりに **人が1回ログインして、その結果のセッションを預かる**。
 *
 * ■ 何を保存するのか
 *   secrets/1688japan/           … ブラウザのプロファイル一式(次回から開くだけで入れる)
 *   secrets/1688japan-state.json … Cookie と localStorage(ヘッドレス実行で使う)
 *   どちらも secrets/ の中で、.gitignore で除外してある。**中身はログイン情報そのもの**なので、
 *   コミットしたり、そのまま人に渡したりしないこと。
 *
 * ■ 使い方
 *   1. このコマンドを実行するとブラウザの窓が開く
 *   2. 画面でIDとパスワードと確認コードを入れてログインする
 *   3. ログインできたことをこちらが見つけたら、自動で保存して終わる
 *      (見つけられなかったときは、コンソールで Enter を押しても保存できる)
 *
 * ■ 入り直しを速くする
 *   .env.local に次の2つを入れておくと、IDとパスワードを自動で埋める。
 *   人が打つのは**画像の確認コード4桁だけ**になるので、入り直しが数十秒で終わる。
 *
 *     SOURCING_1688JP_USER=you@example.com
 *     SOURCING_1688JP_PASS=xxxxxxxx
 *
 *   入れなくても動く(その場合は全部手で打つ)。.env.local は .gitignore 済み。
 */
import "./_env";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium, type BrowserContext } from "playwright";
import { projectRoot } from "./_env";

const LOGIN_URL = "https://pro.1688japan.com/login";
const HOME_URL = "https://pro.1688japan.com/";

const SECRETS = path.join(projectRoot, "secrets");
const PROFILE_DIR = path.join(SECRETS, "1688japan");
const STATE_FILE = path.join(SECRETS, "1688japan-state.json");

/** ログインできているかの判定材料。どれか1つでも当てはまれば「入れた」とみなす */
async function looksLoggedIn(ctx: BrowserContext): Promise<boolean> {
  const page = ctx.pages()[0];
  if (!page) return false;
  try {
    const url = page.url();
    if (/\/login|\/register/.test(url)) return false;
    if (!/1688japan\.com/.test(url)) return false;

    // ログイン後にしか出ない導線を探す(文言は変わりうるので複数見る)
    const marks = ["マイページ", "ログアウト", "会員", "注文", "カート", "残高"];
    const body = (await page.innerText("body").catch(() => "")) || "";
    if (marks.some((m) => body.includes(m)) && !body.includes("ログインしてください")) return true;

    // セッションらしきCookieが増えたかどうか(名前は変わりうるので形で見る)
    const cookies = await ctx.cookies();
    return cookies.some((c) => /sess|token|auth|sid/i.test(c.name) && (c.value?.length ?? 0) > 20);
  } catch {
    return false;
  }
}

async function save(ctx: BrowserContext) {
  fs.mkdirSync(SECRETS, { recursive: true });
  await ctx.storageState({ path: STATE_FILE });
  const cookies = await ctx.cookies();
  console.log(`\n  保存しました:`);
  console.log(`    プロファイル : ${PROFILE_DIR}`);
  console.log(`    セッション   : ${STATE_FILE} (Cookie ${cookies.length}件)`);
  console.log(`  ※ どちらもログイン情報そのものです。コミットしないでください(.gitignore 済み)。`);
}

/** Enter が押されたら解決する。自動判定に失敗したときの逃げ道 */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log("\nブラウザの窓を開きます。画面でログインしてください。");
  console.log(`  ${LOGIN_URL}\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1360, height: 900 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

  // IDとパスワードが分かっていれば先に埋めておく。
  // 残るのは画像の確認コードだけになり、入り直しが一瞬で終わる。
  const user = process.env.SOURCING_1688JP_USER;
  const pass = process.env.SOURCING_1688JP_PASS;
  if (user && pass) {
    try {
      await page.waitForSelector('input[name="username"]', { timeout: 15000 });
      await page.fill('input[name="username"]', user);
      await page.fill('input[type="password"]', pass);
      console.log("  IDとパスワードは入力済みです。画面の確認コード(4桁)だけ入れてください。");
      // 確認コードの欄にカーソルを置いておく(そのまま打てるように)
      await page.locator('input[placeholder*="確認コード"]').first().click({ timeout: 5000 }).catch(() => {});
    } catch {
      console.log("  自動入力できませんでした。画面で入力してください。");
    }
  } else {
    console.log("  (.env.local に SOURCING_1688JP_USER / _PASS を入れておくと、次回から自動で埋まります)");
  }

  // すでにプロファイルにセッションが残っていることもある
  await page.waitForTimeout(3000);
  if (await looksLoggedIn(ctx)) {
    console.log("  すでにログイン済みでした。");
    await save(ctx);
    await ctx.close();
    return;
  }

  console.log("  ログインが終わるのを待っています(最大15分)。");
  console.log("  自動で気づかない場合は、この画面で Enter を押してください。\n");

  const deadline = Date.now() + 15 * 60 * 1000;
  let done = false;

  // Enter が押されたら、その時点の状態で保存する
  const manual = waitForEnter().then(() => {
    if (!done) console.log("\n  Enter を受け取りました。いまの状態を保存します。");
    done = true;
  });

  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await looksLoggedIn(ctx)) {
      done = true;
      console.log("\n  ログインを確認しました。");
      break;
    }
  }
  void manual;

  if (!done) {
    console.log("\n  時間切れです。保存せずに終わります。もう一度実行してください。");
    await ctx.close();
    process.exit(1);
  }

  await save(ctx);

  // 何が見えているかを記録しておく(次の実装の手がかりになる)
  try {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    console.log(`\n  ログイン後のURL: ${page.url()}`);
  } catch {
    /* 記録できなくても保存はできている */
  }

  await ctx.close();
  console.log("\n  完了しました。ブラウザを閉じました。\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n失敗しました:", e instanceof Error ? e.message : e);
  process.exit(1);
});
