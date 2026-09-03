/**
 * supabase/schema.sql を Supabase に適用する。
 *   npm run db:push
 *
 * スキーマはこのファイル1本にまとまっている(マイグレーションを分けていない)。
 * 何度実行しても同じ結果になるよう書いてあるので、変更したら都度これを流せばよい。
 *
 * DATABASE_URL(.env.local)があれば直接つないで適用する。
 * 無ければ、貼り付け用に中身を表示して手順を案内する。
 */
import "./_env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { projectRoot } from "./_env";

const SQL_PATH = path.join(projectRoot, "supabase", "schema.sql");

async function main() {
  const sql = readFileSync(SQL_PATH, "utf8");
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.log(
      "\n" +
        "DATABASE_URL が未設定のため、直接は適用できません。\n" +
        "次のどちらかで適用してください。\n" +
        "\n" +
        "  【方法A】手で貼る(今回だけならこちらが早い)\n" +
        `    1. ${SQL_PATH} を開く\n` +
        "    2. 全部コピーする\n" +
        "    3. Supabase ダッシュボード > SQL Editor に貼って Run\n" +
        "\n" +
        "  【方法B】次回から自動にする(おすすめ)\n" +
        "    1. Supabase ダッシュボード > Project Settings > Database\n" +
        "    2. Connection string の URI をコピー([YOUR-PASSWORD]は実際のパスワードに置換)\n" +
        "    3. .env.local に DATABASE_URL=... として保存\n" +
        "    4. npm run db:push を再実行\n" +
        "\n" +
        "適用後は npm run db:check で確認できます。\n"
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  console.log(`\nスキーマを適用します: ${SQL_PATH}`);
  await client.connect();
  try {
    await client.query(sql);
    console.log("適用が完了しました。");
    console.log("確認: npm run db:check\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\n適用に失敗しました: ${msg}\n`);
    console.error("スキーマは何度実行しても大丈夫な書き方にしてあります。");
    console.error("それでも失敗する場合は、上のエラー文を確認してください。\n");
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
