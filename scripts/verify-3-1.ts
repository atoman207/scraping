/**
 * 3-1 セラーリサーチの「正しさ」を確かめる。
 *   npm run verify:3-1 -- --keyword "スマホ スタンド" --sample 10
 *
 * ■ 何をしているか
 *   検索で集めたデータ(A)を、**商品ページの実物(B)** と1件ずつ突き合わせる。
 *
 *     A: 検索結果ページを開いたときにブラウザが受け取るレスポンス
 *        → lib/scraper/mercari-search.ts が解釈している
 *     B: 商品ページを開いてDOMから読み取った内容
 *        → lib/scraper/mercari.ts の getItemDetail()
 *
 *   AとBは**取得経路も解析コードも別物**なので、両方が一致すれば
 *   「たまたま動いている」のではなく解釈が正しいと言える。
 *   食い違えば、どちらの解釈が壊れたのかを切り分ける手がかりになる。
 *
 * ■ 突き合わせる項目
 *   セラーID / タイトル / 価格 / 商品状態(新品か) / 発送方法
 *
 *   セラーIDが一番大事。従来の実装が上位30件しか解決できていなかった箇所で、
 *   ここが合っていないと集計(誰が何件売ったか)が丸ごと嘘になる。
 *
 * ■ 商品ページを開く分だけアクセスが増えるので、標本は少なめ(既定10件)にしている。
 */
import "./_env";
import { parseArgs, argOne } from "./_env";
import { MercariScraper } from "../lib/scraper/mercari";
import { BlockedError } from "../lib/scraper/types";

const args = parseArgs(process.argv.slice(2));
const keyword = argOne(args, "keyword") ?? "スマホ スタンド";
const pages = Number(argOne(args, "pages") ?? 1);
const sample = Number(argOne(args, "sample") ?? 10);
const intervalMs = Number(argOne(args, "interval") ?? 5000);

type FieldResult = { match: number; differ: number; unknown: number };
const F = (): FieldResult => ({ match: 0, differ: 0, unknown: 0 });

/** 発送方法の比較用に正規化する */
function normShip(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/\s+/g, "").replace(/[（(].*?[）)]/g, "").trim() || null;
}

/**
 * 発送方法が一致しているか。
 *
 * 検索レスポンスは配送方法マスタの名前そのまま(「ゆうゆうメルカリ便」)だが、
 * 商品ページは説明を足した文言になる(「ゆうゆうメルカリ便郵便局/コンビニ受取匿名配送」)。
 * 同じ配送方法を指しているので、**どちらかがどちらかで始まっていれば一致**とみなす。
 */
function shipMatches(fromSearch: string | null, fromItemPage: string | null): boolean {
  if (!fromSearch || !fromItemPage) return false;
  return fromItemPage.startsWith(fromSearch) || fromSearch.startsWith(fromItemPage);
}

async function main() {
  const log = (m: string) => console.log(m);
  const scraper = new MercariScraper({ minIntervalMs: intervalMs, log: () => {} });
  await scraper.start();
  const started = Date.now();

  try {
    console.log(`\n=== 3-1 の精度検証 ===`);
    console.log(`  キーワード: ${keyword} / ${pages}ページ / 標本${sample}件\n`);

    // ---- A: 検索から取得 ----
    console.log(`[1] 検索結果を取得します…`);
    let numFound: number | null = null;
    const listings = await scraper.searchSold(keyword, [], pages, {
      onPage: (i) => {
        if (i.numFound !== null) numFound = i.numFound;
        console.log(`    ${i.page}/${i.pages}ページ 取得${i.got}件 累計${i.total}件`);
      },
    });
    if (!listings.length) {
      console.log("  売れた出品が0件でした。キーワードを変えて試してください。");
      return;
    }
    console.log(`  → 売れた出品 ${listings.length}件 / セラー ${new Set(listings.map((l) => l.seller_external_id)).size}人`);
    if (numFound !== null) {
      console.log(`  → メルカリ側の総ヒット数: ${(numFound as number).toLocaleString()}件`);
      console.log(`     ※ メルカリで同じ条件を手で検索し、表示される件数と近ければ検索条件は正しい`);
    }

    // ---- 標本を選ぶ(偏らないよう全体から等間隔に) ----
    const step = Math.max(1, Math.floor(listings.length / sample));
    const targets = listings.filter((_, i) => i % step === 0).slice(0, sample);
    console.log(`\n[2] ${targets.length}件の商品ページを開いて突き合わせます…`);
    console.log(`    (1件あたり約${(intervalMs / 1000).toFixed(0)}秒。全部で約${Math.round((targets.length * intervalMs) / 1000)}秒)\n`);

    const res = {
      seller: F(),
      title: F(),
      price: F(),
      isNew: F(),
      ship: F(),
    };
    const diffs: string[] = [];
    let fetched = 0;
    let failed = 0;

    for (const [i, a] of targets.entries()) {
      let b;
      try {
        b = await scraper.getItemDetail(a.external_id);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        failed++;
        console.log(`  [${i + 1}/${targets.length}] ${a.external_id} 商品ページを開けませんでした`);
        continue;
      }
      if (!b) {
        failed++;
        continue;
      }
      fetched++;

      const line: string[] = [];

      // セラーID(最重要)
      if (!b.seller_external_id) res.seller.unknown++;
      else if (b.seller_external_id === a.seller_external_id) res.seller.match++;
      else {
        res.seller.differ++;
        line.push(`セラーID 検索=${a.seller_external_id} / 商品ページ=${b.seller_external_id}`);
      }

      // タイトル
      if (!b.title) res.title.unknown++;
      else if (b.title.trim() === a.title.trim()) res.title.match++;
      else {
        res.title.differ++;
        line.push(`タイトル 検索="${a.title.slice(0, 30)}" / 商品ページ="${b.title.slice(0, 30)}"`);
      }

      // 価格
      if (b.price === null) res.price.unknown++;
      else if (b.price === a.price) res.price.match++;
      else {
        res.price.differ++;
        line.push(`価格 検索=¥${a.price} / 商品ページ=¥${b.price}`);
      }

      // 商品状態(新品か)
      if (b.is_new === null || a.is_new === null) res.isNew.unknown++;
      else if (b.is_new === a.is_new) res.isNew.match++;
      else {
        res.isNew.differ++;
        line.push(`商品状態 検索=${a.is_new ? "新品" : "中古"} / 商品ページ="${b.condition}"`);
      }

      // 発送方法
      const as = normShip(a.shipping_method);
      const bs = normShip(b.shipping_method);
      if (!as || !bs) res.ship.unknown++;
      else if (shipMatches(as, bs)) res.ship.match++;
      else {
        res.ship.differ++;
        line.push(`発送方法 検索="${a.shipping_method}" / 商品ページ="${b.shipping_method}"`);
      }

      const mark = line.length ? "△" : "○";
      console.log(`  [${i + 1}/${targets.length}] ${mark} ${a.external_id}  ${a.title.slice(0, 26)}`);
      for (const l of line) {
        console.log(`         ${l}`);
        diffs.push(`${a.external_id}: ${l}`);
      }
    }

    // ---- 結果 ----
    console.log(`\n=== 突き合わせ結果 (${fetched}件を照合${failed ? ` / ${failed}件は取得失敗` : ""}) ===\n`);
    const rows: [string, FieldResult, string][] = [
      ["セラーID", res.seller, "★これが合っていないと集計が丸ごと嘘になる"],
      ["タイトル", res.title, ""],
      ["価格", res.price, ""],
      ["商品状態(新品率の元)", res.isNew, ""],
      ["発送方法", res.ship, "商品ページ側は説明が付くので前方一致で判定"],
    ];
    let allOk = true;
    for (const [label, r, note] of rows) {
      const judged = r.match + r.differ;
      const pct = judged ? Math.round((r.match / judged) * 1000) / 10 : null;
      const mark = r.differ === 0 ? "OK" : "NG";
      if (r.differ > 0) allOk = false;
      console.log(
        `  ${mark}  ${label.padEnd(22)} 一致 ${String(r.match).padStart(3)} / 相違 ${String(r.differ).padStart(3)}` +
          ` / 判定不能 ${String(r.unknown).padStart(3)}` +
          (pct !== null ? `  (${pct}%)` : "") +
          (note ? `  ${note}` : "")
      );
    }

    console.log(`\n=== 判定 ===`);
    if (allOk && res.seller.match > 0) {
      console.log(`  合格。検索から取れたデータは商品ページの実物と一致しています。`);
    } else if (!allOk) {
      console.log(`  相違があります。下の項目を確認してください:`);
      for (const d of diffs.slice(0, 10)) console.log(`    ・${d}`);
      console.log(`\n  相違が出やすい正常なケース:`);
      console.log(`    ・価格 … 検索した後に値下げされた（時間差。数件なら正常）`);
      console.log(`    ・発送方法 … 商品ページ側の文言に説明が付く場合（前方一致で吸収済み）`);
      console.log(`  セラーIDが食い違う場合は正常ではありません。解析コードの見直しが必要です。`);
    }
    console.log(`\n  所要 ${Math.round((Date.now() - started) / 1000)}秒\n`);

    if (res.seller.differ > 0) process.exitCode = 1;
  } catch (e) {
    if (e instanceof BlockedError) {
      console.error(`\nメルカリ側にアクセスを拒否されました。時間をおいて --interval 8000 で再実行してください。\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  } finally {
    await scraper.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
