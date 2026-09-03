/**
 * supabase/migrations/*.sql を番号順に適用する。
 *   npm run db:migrate
 *
 * schema.sql（初回の作成）とは別に、後から足した列や作り直したビューを当てるためのもの。
 * 各マイグレーションは何度実行しても壊れない書き方（IF NOT EXISTS / OR REPLACE）にしてある。
 *
 * DATABASE_URL が未設定なら、貼り付け用のSQLを1本にまとめて出力する。
 * それを Supabase ダッシュボードの SQL Editor に貼って Run すれば同じ結果になる。
 */
import "./_env";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { projectRoot } from "./_env";

const dir = path.join(projectRoot, "supabase", "migrations");

function files(): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 001_, 002_ ... の番号順
}

async function main() {
  const list = files();
  if (!list.length) {
    console.log(`マイグレーションがありません: ${dir}`);
    return;
  }
  console.log(`対象 ${list.length}件: ${list.join(", ")}`);

  const url = process.env.DATABASE_URL;
  if (!url) {
    // 直接つなげないので、貼り付け用に1本化して出す
    const merged = list
      .map((f) => `-- ===== ${f} =====\n${readFileSync(path.join(dir, f), "utf8")}`)
      .join("\n\n");
    const out = path.join(projectRoot, "supabase", "_migrations-merged.sql");
    writeFileSync(out, merged, "utf8");
    console.log(
      "\nDATABASE_URL が未設定のため、直接は適用できません。\n" +
        `貼り付け用のSQLを書き出しました: ${out}\n` +
        "Supabase ダッシュボード > SQL Editor にこの中身を貼って Run してください。\n" +
        "（DATABASE_URL を .env.local に設定すれば、次回から自動で当たります）"
    );
    return;
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const f of list) {
      const sql = readFileSync(path.join(dir, f), "utf8");
      process.stdout.write(`  適用中 ${f} ... `);
      await client.query(sql);
      console.log("OK");
    }
    console.log("マイグレーション完了");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
