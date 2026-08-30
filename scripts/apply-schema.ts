/**
 * supabase/schema.sql をSupabaseのPostgreSQLに適用する。
 *   npm run db:push
 *
 * .env.local の DATABASE_URL(Supabase > Project Settings > Database > Connection string)
 * が必要。設定していない場合は、Supabaseダッシュボードの SQL Editor に
 * supabase/schema.sql の中身を貼り付けて実行しても同じ。
 */
import "./_env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { projectRoot } from "./_env";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL が未設定です。\n" +
        "  方法A: .env.local に DATABASE_URL を設定して再実行\n" +
        "  方法B: Supabaseダッシュボード > SQL Editor に supabase/schema.sql を貼って実行"
    );
    process.exit(1);
  }

  const sqlPath = path.join(projectRoot, "supabase", "schema.sql");
  const sql = readFileSync(sqlPath, "utf8");

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`スキーマ適用完了: ${sqlPath}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
