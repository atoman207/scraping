/**
 * 3-3 仕入れ候補の検索(コマンドライン)。
 *
 *   npm run scrape:sourcing -- --group 12
 *   npm run scrape:sourcing -- --group 12 --mode title --limit 20 --apply
 *   npm run scrape:sourcing -- --seller 5          # そのセラーの鉄板商品をまとめて
 *
 * 画面のボタン(深掘りリスト)と同じ処理を、常駐サーバーのコマンドラインから叩くためのもの。
 * Vercelなど画面側でブラウザを起動できない構成では、こちらか npm run worker を使う。
 *
 * オプション
 *   --group  <id>    product_groups.id。複数回指定できる
 *   --seller <id>    sellers.id。そのセラーの鉄板商品(is_repeat=1)をまとめて処理する
 *   --mode   <m>     title / image。既定は両方
 *   --limit  <n>     探し方ごとの取得件数(既定12)
 *   --apply          単価が未入力の深掘りリストに最有力候補を反映する
 *   --interval <ms>  ページを開く間隔(既定3000)
 */
import "./_env";
import { parseArgs, argOne } from "./_env";
import { getSupabase, must } from "../lib/supabase";
import { runSourcing } from "../lib/scraper/sourcing-run";
import { BlockedError, parseSourcingModes } from "../lib/scraper/types";

const args = parseArgs(process.argv.slice(2));
const limit = Number(argOne(args, "limit") ?? 12);
const intervalMs = Number(argOne(args, "interval") ?? 3000);
const apply = "apply" in args;
const modes = args.mode?.length ? parseSourcingModes(args.mode) : (["title", "image"] as const).slice();

async function resolveGroupIds(): Promise<number[]> {
  const direct = (args.group ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const sellerId = Number(argOne(args, "seller") ?? 0);
  if (!sellerId) return direct;

  // セラー指定のときは鉄板商品(2回以上出品)だけを対象にする。
  // 単発の出品まで仕入れ候補を探しても、判断材料にならないため。
  const rows = (must(
    await getSupabase()
      .from("product_groups")
      .select("id")
      .eq("seller_id", sellerId)
      .eq("is_repeat", 1)
      .order("sold_count", { ascending: false })
  ) ?? []) as { id: number }[];
  return [...new Set([...direct, ...rows.map((r) => r.id)])];
}

async function main() {
  const groupIds = await resolveGroupIds();
  if (!groupIds.length) {
    console.error("対象がありません。--group <product_groups.id> か --seller <sellers.id> を指定してください。");
    process.exit(1);
  }
  if (!modes.length) {
    console.error("--mode は title / image のいずれかです。");
    process.exit(1);
  }

  console.log(`対象${groupIds.length}件 / 探し方: ${modes.join("・")} / 各${limit}件${apply ? " / 反映あり" : ""}`);

  let ok = 0;
  let ng = 0;
  for (const [i, id] of groupIds.entries()) {
    console.log(`\n=== [${i + 1}/${groupIds.length}] product_group #${id} ===`);
    try {
      await runSourcing({
        productGroupId: id,
        modes: modes as ("title" | "image")[],
        limit,
        apply,
        intervalMs,
        log: (m) => console.log(m),
      });
      ok++;
    } catch (e) {
      ng++;
      if (e instanceof BlockedError) {
        console.error(`[中断] ${e.message}`);
        console.error(`  URL: ${e.url}`);
        console.error("  断られているので、ここで止めます。時間をおいて実行し直してください。");
        break;
      }
      console.error(`[エラー] ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    }
  }

  console.log(`\n完了: 成功${ok}件 / 失敗${ng}件`);
  if (ng) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
