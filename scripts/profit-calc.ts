/**
 * engine/profit_calc.py のCLI相当。
 *   npm run engine:profit -- --out data/deepdive_report.csv
 * (元の --db は不要。接続先は .env.local の Supabase 設定を使う)
 */
import "./_env";
import path from "node:path";
import { parseArgs, argOne, requireArg } from "./_env";
import { run } from "../lib/engine/profit";

const args = parseArgs(process.argv.slice(2));
if (argOne(args, "db")) {
  console.log("(注) --db は無視されます。接続先は .env.local の Supabase 設定です。");
}
const out = requireArg(args, "out");
const outPath = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);

run(outPath).catch((e) => {
  console.error(e);
  process.exit(1);
});
