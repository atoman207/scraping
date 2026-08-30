/**
 * engine/rank_sellers.py のCLI相当。
 *   npm run engine:rank -- --search_id 1 --keyword "スマホスタンド" --seller_ids 1 2 3
 * (元の --db は不要。接続先は .env.local の Supabase 設定を使う)
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import { run } from "../lib/engine/rank";

const args = parseArgs(process.argv.slice(2));
if (argOne(args, "db")) {
  console.log("(注) --db は無視されます。接続先は .env.local の Supabase 設定です。");
}
const searchId = parseInt(requireArg(args, "search_id"), 10);
const keyword = requireArg(args, "keyword");
const sellerIds = (args["seller_ids"] ?? []).map((v) => parseInt(v, 10)).filter((v) => !Number.isNaN(v));
if (!sellerIds.length) {
  console.error("エラー: --seller_ids は必須です(例: --seller_ids 1 2 3)");
  process.exit(2);
}

run(searchId, keyword, sellerIds).catch((e) => {
  console.error(e);
  process.exit(1);
});
