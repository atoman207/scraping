/**
 * 1688向けの中国語検索語づくりを検証する。
 *   npm run test:zh              … 例題だけ(ネットワーク不要・DB不要)
 *   npm run test:zh -- --db      … いまDBにある商品タイトルで訳せ具合を見る
 *
 * ■ 何のための検証か
 *   対訳表(lib/scraper/zh-query.ts の JA_ZH)は手で育てるものなので、
 *   「いま何割の商品で中国語の検索語を作れているか」が分からないと育てようがない。
 *   --db を付けると、実際に深掘り対象になっている商品のタイトルを流して、
 *   **訳せなかった語を出現回数の多い順に出す**。そこに出てくる語を対訳表へ足せば、
 *   次からは訳せるようになる。
 */
import "./_env";
import { parseArgs } from "./_env";
import { toChineseQuery } from "../lib/scraper/zh-query";

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "  OK  " : "  NG  "} ${label}${cond ? "" : `  ${detail}`}`);
}

function eq(label: string, got: unknown, want: unknown) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) pass++;
  else fail++;
  console.log(`${same ? "  OK  " : "  NG  "} ${label}`);
  if (!same) console.log(`         got=${JSON.stringify(got)}\n         want=${JSON.stringify(want)}`);
}

// ============================================================ 1. 基本
console.log("\n=== 1. 対訳表で中国語にする ===");

eq("複合語を先に取る", toChineseQuery("スマホスタンド 折りたたみ").query, "手机支架 折叠");
eq("売り文句を落とす", toChineseQuery("新品未使用 送料無料 まな板").query, "砧板");
eq("記号を落とす", toChineseQuery("【人気】★ペット ハーネス★").query, "宠物 胸背带");
ok("訳した語を記録している", toChineseQuery("車載ホルダー").matched.length === 1, JSON.stringify(toChineseQuery("車載ホルダー").matched));
ok("対訳表で訳せたら confident", toChineseQuery("ヨガマット").confident === true);

// ============================================================ 2. 語数の上限
console.log("\n=== 2. 語数を絞る ===");

const many = toChineseQuery("スマホ ケース カバー 財布 帽子 手袋 時計");
ok("4語までに抑える", many.query.split(" ").length <= 4, many.query);

// ============================================================ 3. 訳せないとき
console.log("\n=== 3. 対訳表に無いとき ===");

const unknown = toChineseQuery("ジュエリールーペ 30倍 21mm");
ok("ルーペは対訳表にある", unknown.query.includes("放大镜"), unknown.query);

const noHit = toChineseQuery("ワケアリ ノベルティ グッズ");
ok("訳せないときは confident=false", noHit.confident === false, JSON.stringify(noHit));
ok(
  "訳せなかった語を返す(対訳表に足す手がかりになる)",
  noHit.unmatched.length > 0,
  JSON.stringify(noHit.unmatched)
);

// ============================================================ 4. 日本語を混ぜない
console.log("\n=== 4. 出力に日本語が混ざらない ===");

const KANA = /[ぁ-んァ-ヶー]/;
for (const t of [
  "スマホスタンド 車載 折りたたみ",
  "ペット ハーネス 猫 犬",
  "ステンレス 水筒 保温 大容量",
  "トレーニンググローブ L 筋トレ リストラップ",
]) {
  const q = toChineseQuery(t);
  ok(`かなが残らない: ${t.slice(0, 22)} → ${q.query}`, !KANA.test(q.query), q.query);
}

// ============================================================ 5. 実データ(任意)
async function withDb() {
  console.log("\n=== 5. いまDBにある商品タイトルでの訳せ具合 ===");
  const { getSupabase, must } = await import("../lib/supabase");
  const rows = (must(
    await getSupabase().from("product_groups").select("representative_title").limit(500)
  ) ?? []) as { representative_title: string }[];

  if (!rows.length) {
    console.log("  商品がまだありません(セラー深掘りを実行すると入ります)。");
    return;
  }

  let confident = 0;
  let empty = 0;
  const missing = new Map<string, number>();

  for (const r of rows) {
    const q = toChineseQuery(r.representative_title);
    if (q.confident) confident++;
    if (!q.query) empty++;
    for (const w of q.unmatched) missing.set(w, (missing.get(w) ?? 0) + 1);
  }

  const pct = Math.round((confident / rows.length) * 100);
  console.log(`  商品 ${rows.length}件`);
  console.log(`  対訳表で訳せた       : ${confident}件 (${pct}%)`);
  console.log(`  漢字そのまま(要確認) : ${rows.length - confident - empty}件`);
  console.log(`  検索語を作れなかった : ${empty}件`);

  const top = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  if (top.length) {
    console.log("\n  訳せなかった語(多い順・対訳表に足す候補):");
    for (const [w, n] of top) console.log(`    ${String(n).padStart(3)}回  ${w}`);
  }

  // 何件か実例を出す。数字だけだと質が分からない
  console.log("\n  例:");
  for (const r of rows.slice(0, 8)) {
    const q = toChineseQuery(r.representative_title);
    console.log(`    ${r.representative_title.slice(0, 34).padEnd(34)} → ${q.query || "(作れず)"}${q.confident ? "" : "  ※要確認"}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ("db" in args) {
    try {
      await withDb();
    } catch (e) {
      console.log(`  DBを読めませんでした: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
    }
  } else {
    console.log("\n(--db を付けると、いまDBにある商品タイトルでの訳せ具合も見られます)");
  }

  console.log(`\n合計: OK ${pass} / NG ${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
