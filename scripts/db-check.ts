/**
 * マイグレーションが当たっているかを確認する。
 *   npm run db:check
 *
 * 追加したはずの列が実際にDBにあるかを1つずつ見て、無ければどのSQLを流せばよいか出す。
 */
import "./_env";
import { getSupabase } from "../lib/supabase";

/** 確認したい「テーブル: [列, …]」と、それを追加するマイグレーション */
const EXPECTED: { table: string; columns: string[]; migration: string }[] = [
  {
    table: "settings",
    columns: ["import_tax_pct"],
    migration: "supabase/schema.sql",
  },
  {
    table: "deepdive_items",
    columns: [
      "cost_mode",
      "cost_direct_jpy",
      "china_domestic_cny",
      "tariff_cat",
      "box_count",
      "packaging_jpy",
      "monthly_qty",
      "sell_price_jpy",
      "shipping_jpy",
    ],
    migration: "supabase/schema.sql",
  },
  {
    table: "listings",
    columns: ["is_new", "updated_at", "shipping_method_id", "is_shops", "matched_keyword"],
    migration: "supabase/schema.sql",
  },
  {
    table: "seller_research_results",
    columns: ["genre_count", "seller_type"],
    migration: "supabase/schema.sql",
  },
  {
    table: "jobs",
    columns: ["kind", "params", "status", "progress", "log", "result", "heartbeat_at", "seq"],
    migration: "supabase/schema.sql",
  },
];

async function main() {
  const sb = getSupabase();
  const needed = new Set<string>();
  let ok = 0;
  let ng = 0;

  console.log("\n=== マイグレーションの適用状況 ===");
  for (const { table, columns, migration } of EXPECTED) {
    // 存在しない列を select すると PostgREST がエラーを返すので、それで判定する
    const res = await sb.from(table).select(columns.join(",")).limit(1);
    if (res.error) {
      ng++;
      needed.add(migration);
      console.log(`  NG  ${table.padEnd(26)} ${res.error.message.slice(0, 80)}`);
    } else {
      ok++;
      console.log(`  OK  ${table.padEnd(26)} ${columns.length}列を確認`);
    }
  }

  // ビューも確認する(計算に使う素材が揃っているか)
  const v = await sb.from("deepdive_view").select("cost_mode,import_tax_pct,sell_price_jpy").limit(1);
  if (v.error) {
    ng++;
    needed.add("supabase/schema.sql");
    console.log(`  NG  ${"deepdive_view".padEnd(26)} ${v.error.message.slice(0, 80)}`);
  } else {
    ok++;
    console.log(`  OK  ${"deepdive_view".padEnd(26)} 作り直し済み`);
  }

  // ジョブキューの関数も確認する
  const rpc = await sb.rpc("claim_job", { worker_id: "db-check(取得はしない)" });
  if (rpc.error && /function|does not exist/i.test(rpc.error.message)) {
    ng++;
    needed.add("supabase/schema.sql");
    console.log(`  NG  ${"claim_job()".padEnd(26)} 未作成`);
  } else {
    ok++;
    console.log(`  OK  ${"claim_job()".padEnd(26)} 呼び出せました`);
    // 取ってしまったジョブがあれば queued に戻す
    const rows = (rpc.data ?? []) as { id: number }[];
    for (const r of rows) {
      await sb.from("jobs").update({ status: "queued", locked_by: null }).eq("id", r.id);
      console.log(`      (確認のため取得したジョブ #${r.id} は queued に戻しました)`);
    }
  }

  console.log(`\n  OK ${ok}件 / NG ${ng}件`);
  if (needed.size) {
    console.log(`\n  未適用のマイグレーション: ${[...needed].join(", ")}`);
    console.log(`  対処: npm run db:push（DATABASE_URL未設定なら supabase/schema.sql を SQL Editor に貼って実行）\n`);
    process.exit(1);
  }
  console.log(`  すべて適用済みです。\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
