/**
 * DBの現状(行数)と、Supabase無料枠(500MB)をいつ使い切るかの見積り。
 *   npm run db:stats
 *
 * 無料枠のまま運用を続けてよいか判断するために使う。
 */
import "./_env";
import { getSupabase } from "../lib/supabase";

/** 1行あたりの概算バイト数(実測に近い保守的な値。索引込み) */
const ROW_BYTES: Record<string, number> = {
  searches: 200,
  sellers: 400,
  listings: 700, // タイトル・URL・画像URLが長いので大きめ
  product_groups: 500,
  deepdive_items: 3000, // ali_candidates などJSONを持つので大きい
  seller_research_results: 250,
  jobs: 2000, // ログ配列を持つ
};

const TABLES = Object.keys(ROW_BYTES);
const FREE_LIMIT_MB = 500;

async function main() {
  const sb = getSupabase();
  console.log("\n=== DBの現状 ===");
  let totalRows = 0;
  let totalBytes = 0;
  const missing: string[] = [];

  for (const t of TABLES) {
    // head:true の問い合わせは、テーブルが無くてもエラーを返さず count が null になる。
    // 「0行」と「テーブルが無い」を取り違えないよう、count が null なら未作成として扱う。
    const r = await sb.from(t).select("*", { count: "exact", head: true });
    if (r.error || r.count === null || r.count === undefined) {
      missing.push(t);
      console.log(`  ${t.padEnd(26)} —  未作成`);
      continue;
    }
    const n = r.count;
    const bytes = n * ROW_BYTES[t];
    totalRows += n;
    totalBytes += bytes;
    console.log(`  ${t.padEnd(26)} ${String(n).padStart(8)}行  約${(bytes / 1024 / 1024).toFixed(1)}MB`);
  }

  const usedMb = totalBytes / 1024 / 1024;
  console.log(`  ${"合計".padEnd(24)} ${String(totalRows).padStart(8)}行  約${usedMb.toFixed(1)}MB / ${FREE_LIMIT_MB}MB`);

  if (missing.length) {
    console.log(`\n  ※ 未作成のテーブル: ${missing.join(", ")}`);
    console.log(`     npm run db:migrate で出力したSQLを Supabase の SQL Editor で実行してください。`);
  }

  // ---- 使い切るまでの見積り ----
  // セラーリサーチ1回 = 上位60セラー分の出品を保存 ≒ 400行程度
  const ROWS_PER_RESEARCH = 400;
  const BYTES_PER_RESEARCH = ROWS_PER_RESEARCH * ROW_BYTES.listings;
  const remainMb = FREE_LIMIT_MB - usedMb;
  const perResearchMb = BYTES_PER_RESEARCH / 1024 / 1024;
  const researchesLeft = Math.floor(remainMb / perResearchMb);

  console.log(`\n=== 無料枠(500MB)の見積り ===`);
  console.log(`  セラーリサーチ1回あたり 約${perResearchMb.toFixed(2)}MB (出品${ROWS_PER_RESEARCH}行の想定)`);
  console.log(`  残り 約${remainMb.toFixed(0)}MB → あと約${researchesLeft.toLocaleString()}回ぶん`);
  for (const perMonth of [30, 100, 300]) {
    const months = Math.floor(researchesLeft / perMonth);
    console.log(`    月${String(perMonth).padStart(3)}回のペースなら 約${months}ヶ月 (${(months / 12).toFixed(1)}年)`);
  }

  console.log(`\n=== 無料枠で注意すべき点 ===`);
  console.log(`  ・7日間アクセスが無いとプロジェクトが自動停止する`);
  console.log(`    → ワーカーを常駐させていれば5秒ごとに問い合わせるので停止しない`);
  console.log(`  ・自動バックアップが無い`);
  console.log(`    → npm run db:backup を定期実行してVPS内にも控えを取ること`);
  console.log(`  ・転送量は月5GBまで`);
  console.log(`    → 画面表示とワーカーの読み書きが対象。通常の使い方なら十分\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
