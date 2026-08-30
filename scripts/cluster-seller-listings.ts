/**
 * engine/cluster_seller_listings.py のCLI相当。
 *   npm run engine:cluster -- --seller_id 1
 * (元の --db は不要。接続先は .env.local の Supabase 設定を使う)
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import { run } from "../lib/engine/cluster";

const args = parseArgs(process.argv.slice(2));
if (argOne(args, "db")) {
  console.log("(注) --db は無視されます。接続先は .env.local の Supabase 設定です。");
}
const sellerId = parseInt(requireArg(args, "seller_id"), 10);

run(sellerId).catch((e) => {
  console.error(e);
  process.exit(1);
});
