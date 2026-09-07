/**
 * 3-3 AliExpress / 1688 連携の「正しさ」を、実サイトを開いて確かめる。
 *
 *   npm run verify:3-3 -- --title "折りたたみ スマホスタンド"
 *   npm run verify:3-3 -- --group 12 --sample 3
 *   npm run verify:3-3 -- --title "..." --image "https://static.mercdn.net/..."
 *
 * ■ 何をしているか
 *   検索結果カードから読んだ値(A)を、**商品ページの実物(B)** と突き合わせる。
 *
 *     A: 検索結果ページのカード(lib/scraper/sourcing.ts の parseAeCardText)
 *     B: 商品ページの og:title / h1 と、ページ内の価格表示
 *
 *   AとBは取得経路が別なので、両方が一致すれば「たまたま動いている」のではなく
 *   カードの読み取りが正しいと言える。
 *
 * ■ 価格について
 *   AliExpressは同じ商品でも、検索結果・商品ページ・新規向けクーポンで
 *   **表示価格が変わる**。ここでは金額の一致までは求めず、
 *   「両方に妥当な価格表示があるか」と、その差を目で見えるように出す。
 *
 * ■ このスクリプトはDBに書き込まない(検索の正しさだけを見る)。
 *   保存まで含めて動かすなら npm run scrape:sourcing -- --group <id> を使う。
 */
import "./_env";
import { parseArgs, argOne } from "./_env";
import { getSupabase, must } from "../lib/supabase";
import { ScraperSession } from "../lib/scraper/browser";
import {
  Alibaba1688Sourcing,
  AliExpressSourcing,
  toSearchQuery,
} from "../lib/scraper/sourcing";
import { rankCandidates } from "../lib/scraper/sourcing-run";
import { BlockedError, type SourcingCandidate } from "../lib/scraper/types";

const args = parseArgs(process.argv.slice(2));
const sample = Number(argOne(args, "sample") ?? 3);
const limit = Number(argOne(args, "limit") ?? 12);
const intervalMs = Number(argOne(args, "interval") ?? 3000);
const rate = Number(argOne(args, "rate") ?? 24);

let pass = 0;
let fail = 0;
let warn = 0;

function check(label: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "OK" : "NG"}  ${label}${detail ? `  ${detail}` : ""}`);
}
function note(label: string, detail = "") {
  warn++;
  console.log(`  --  ${label}${detail ? `  ${detail}` : ""}`);
}

/** 突合用の正規化(全角空白・記号のゆらぎを吸収する) */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[、,。.・:：\-‐−ー]/g, "");
}

async function resolveTarget(): Promise<{ title: string; image: string | null }> {
  const groupId = Number(argOne(args, "group") ?? 0);
  if (groupId) {
    const g = must(
      await getSupabase()
        .from("product_groups")
        .select("representative_title, representative_image_url")
        .eq("id", groupId)
        .single()
    ) as { representative_title: string; representative_image_url: string | null };
    return { title: g.representative_title, image: argOne(args, "image") ?? g.representative_image_url };
  }
  const title = argOne(args, "title");
  if (!title) {
    console.error("--title か --group を指定してください。");
    console.error('  例: npm run verify:3-3 -- --title "折りたたみ スマホスタンド"');
    process.exit(1);
  }
  return { title, image: argOne(args, "image") ?? null };
}

/** 商品ページを開いて、タイトルと価格表示を読む */
async function readItemPage(
  session: ScraperSession,
  url: string
): Promise<{ title: string | null; prices: number[] } | null> {
  try {
    const page = await session.goto(url, 9000);
    // 商品ページは描画に時間がかかる。検索結果より長めに待つ
    await page.waitForTimeout(4000);
    return await page.evaluate(() => {
      const og = document.querySelector("meta[property='og:title']")?.getAttribute("content") ?? null;
      const h1 = document.querySelector("h1")?.textContent ?? null;
      const text = document.body.innerText;
      const prices = (text.match(/[\d,]+円/g) ?? [])
        .slice(0, 6)
        .map((s) => Number(s.replace(/[,円]/g, "")))
        .filter((n) => Number.isFinite(n));
      return { title: (h1 || og || "").replace(/ - AliExpress.*$/, "").trim() || null, prices };
    });
  } catch (e) {
    console.log(`      (商品ページを開けませんでした: ${String(e).slice(0, 90)})`);
    return null;
  }
}

async function main() {
  const target = await resolveTarget();
  const query = toSearchQuery(target.title);

  console.log("\n================ 3-3 ライブ検証 ================");
  console.log(`対象タイトル: ${target.title}`);
  console.log(`検索語      : 「${query}」`);
  console.log(`画像        : ${target.image ?? "(なし)"}`);
  console.log(`為替        : ${rate} 円/元 / 取得上限 ${limit}件 / 突合 ${sample}件`);

  // 検索そのものはDBが無くても動くが、保存先が無いと画面には出ない。先に知らせる
  console.log("\n[0] 保存先(sourcing_candidates)の確認");
  const table = await getSupabase().from("sourcing_candidates").select("id").limit(1);
  if (table.error) {
    note("テーブルがまだありません", table.error.message.slice(0, 70));
    console.log("      → supabase/schema.sql を Supabase の SQL Editor に貼って Run してください");
    console.log("        (この検証は検索だけを見るので、このまま続けられます)");
  } else {
    check("候補の保存先がある", true);
  }

  const ae = new AliExpressSourcing(rate, { minIntervalMs: intervalMs, log: (m) => console.log(m) });
  let byTitle: SourcingCandidate[] = [];
  let byImage: SourcingCandidate[] = [];

  try {
    await ae.start();

    console.log("\n[1] タイトル検索");
    byTitle = await ae.searchCandidates(target.title, limit);
    check("候補を1件以上取得できた", byTitle.length > 0, `${byTitle.length}件`);

    const priced = byTitle.filter((c) => c.price_cny !== null).length;
    check(
      "価格を読み取れた候補が半分以上ある",
      byTitle.length > 0 && priced / byTitle.length >= 0.5,
      `${priced}/${byTitle.length}件`
    );
    check(
      "商品URLがすべてAliExpressの商品ページ",
      byTitle.every((c) => /^https:\/\/[a-z.]*aliexpress\.com\/item\/\d+\.html$/.test(c.url)),
      byTitle.find((c) => !/^https:\/\/[a-z.]*aliexpress\.com\/item\/\d+\.html$/.test(c.url))?.url ?? ""
    );
    check(
      "同じ商品が重複していない",
      new Set(byTitle.map((c) => c.external_id)).size === byTitle.length
    );
    check(
      "一致度がすべて0-100の範囲",
      byTitle.every((c) => c.match_score !== null && c.match_score >= 0 && c.match_score <= 100)
    );
    const withImage = byTitle.filter((c) => c.image_url).length;
    if (withImage < byTitle.length) {
      note(
        "画像URLを取れなかった候補がある(遅延読み込み中のカード)",
        `${byTitle.length - withImage}/${byTitle.length}件`
      );
    } else {
      check("すべての候補に画像URLがある", true, `${withImage}件`);
    }

    if (target.image) {
      console.log("\n[2] 画像検索");
      byImage = await ae.searchByImage(target.image, limit, target.title);
      check("画像検索で候補を取得できた", byImage.length > 0, `${byImage.length}件`);
      if (byImage.length) {
        check(
          "画像検索の結果URLを控えている(あとから同じ検索を開ける)",
          byImage.every((c) => (c.query ?? "").includes("isNewImageSearch"))
        );
        check("探し方が image として記録されている", byImage.every((c) => c.search_mode === "image"));
      }
    } else {
      console.log("\n[2] 画像検索 … --image / --group が無いので省略");
    }

    // --- 突合: カードの読み取りが商品ページと合っているか ---
    console.log("\n[3] 商品ページとの突合");
    const ranked = rankCandidates([...byTitle, ...byImage]);
    const targets = ranked.filter((c) => c.search_mode !== "link").slice(0, Math.max(0, sample));
    let titleMatch = 0;
    let titleDiffer = 0;

    for (const [i, c] of targets.entries()) {
      console.log(`\n  (${i + 1}/${targets.length}) ${c.title.slice(0, 60)}`);
      console.log(`      カード: ${c.price_cny !== null ? `${c.price_cny}元 (¥${c.price_jpy})` : "価格不明"} / 一致度${c.match_score}%`);
      const page = await readItemPage(ae.browserSession, c.url);
      if (!page) {
        note("商品ページを読めなかった", c.url);
        continue;
      }
      const same = page.title !== null && norm(page.title).startsWith(norm(c.title).slice(0, 20));
      if (same) titleMatch++;
      else titleDiffer++;
      console.log(`      ページ: ${page.title?.slice(0, 60) ?? "(タイトル無し)"}`);
      console.log(`      価格表示: ${page.prices.length ? page.prices.map((p) => `¥${p.toLocaleString()}`).join(" / ") : "(読めず)"}`);
      if (!same) console.log("      ※ カードとページのタイトルが違います");
      if (page.prices.length && c.price_jpy !== null && !page.prices.includes(c.price_jpy)) {
        console.log("      ※ 金額が一致しません(AliExpressは検索結果とページで違う価格を出すことがあります)");
      }
    }
    if (targets.length) {
      check(
        "カードのタイトルが商品ページと一致する",
        titleDiffer === 0 && titleMatch > 0,
        `一致${titleMatch}件 / 不一致${titleDiffer}件`
      );
    }
  } catch (e) {
    if (e instanceof BlockedError) {
      console.error(`\n[中断] ${e.message}\n  URL: ${e.url}`);
      console.error("  断られたので止めます。時間をおいて、--interval を広げて実行し直してください。");
      process.exit(2);
    }
    throw e;
  } finally {
    await ae.close();
  }

  // --- 1688(検索リンクの組み立てだけ) ---
  console.log("\n[4] 1688(ログインが必要なため検索URLのみ)");
  const alibaba = new Alibaba1688Sourcing();
  const links = [
    ...(await alibaba.searchCandidates(target.title)),
    ...(target.image ? await alibaba.searchByImage(target.image) : []),
  ];
  check("検索URLを組み立てられた", links.length > 0, `${links.length}件`);
  check(
    "URLがすべて1688のもの",
    links.every((l) => l.url.startsWith("https://s.1688.com/")),
    links.find((l) => !l.url.startsWith("https://s.1688.com/"))?.url ?? ""
  );
  for (const l of links) console.log(`      ${l.title}\n        ${l.url}`);

  // --- 一覧 ---
  console.log("\n[5] 並べ替え後の候補一覧");
  const ranked = rankCandidates([...byTitle, ...byImage]);
  for (const [i, c] of ranked.slice(0, 12).entries()) {
    const price = c.price_cny !== null ? `${String(c.price_cny).padStart(7)}元` : "  価格不明";
    const mode = c.search_mode === "image" ? "画像" : c.search_mode === "title" ? "文字" : "LINK";
    console.log(
      `  ${String(i + 1).padStart(2)}. [${mode}] ${price}  一致${String(c.match_score ?? 0).padStart(3)}%  ${c.title.slice(0, 42)}`
    );
  }

  console.log(`\n=== 結果: OK ${pass}件 / NG ${fail}件${warn ? ` / 参考 ${warn}件` : ""} ===\n`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
