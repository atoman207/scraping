/**
 * 発注仕様書 3-3: AliExpress / 1688 連携
 * 鉄板商品(product_groups)のタイトルから仕入れ候補を検索し、結果を表示する。
 * --apply を付けると、最安候補の価格と仕入先URLを深掘りリストに書き込む。
 *
 *   npm run scrape:sourcing -- --group 1
 *   npm run scrape:sourcing -- --group 1 --apply
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import { AliExpressSourcing, Alibaba1688Sourcing } from "../lib/scraper/sourcing";
import { getSupabase, must } from "../lib/supabase";
import { getSettings } from "../lib/db";

const args = parseArgs(process.argv.slice(2));
const groupId = Number(requireArg(args, "group"));
const apply = argOne(args, "apply") !== undefined;
const limit = Number(argOne(args, "limit") ?? 8);

async function main() {
  const sb = getSupabase();
  const group = must(
    await sb.from("product_groups").select("id, representative_title").eq("id", groupId).single()
  ) as { id: number; representative_title: string };

  const settings = await getSettings();
  console.log(`\n=== 3-3 仕入れ候補検索 ===`);
  console.log(`対象: ${group.representative_title}`);
  console.log(`為替: ${settings.exchange_rate_jpy_per_cny} 円/元\n`);

  const ae = new AliExpressSourcing(settings.exchange_rate_jpy_per_cny, { log: (m) => console.log(m) });
  await ae.start();
  let candidates;
  try {
    candidates = await ae.searchCandidates(group.representative_title, limit);
  } finally {
    await ae.close();
  }

  console.log("\n--- AliExpress ---");
  for (const [i, c] of candidates.entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${c.price_cny !== null ? `${c.price_cny}元` : "価格不明"}  ${c.title.slice(0, 60)}`);
    console.log(`    ${c.url}`);
  }

  const cn = new Alibaba1688Sourcing();
  console.log("\n--- 1688(ログインが必要なため検索リンクのみ) ---");
  for (const c of await cn.searchCandidates(group.representative_title)) {
    console.log(`  ${c.title}\n    ${c.url}`);
  }

  if (apply) {
    const cheapest = candidates.filter((c) => c.price_cny !== null).sort((a, b) => a.price_cny! - b.price_cny!)[0];
    if (!cheapest) {
      console.log("\n--apply: 価格が取れた候補が無いため書き込みませんでした。");
      return;
    }
    const items = must(
      await sb.from("deepdive_items").select("id").eq("product_group_id", groupId)
    ) as { id: number }[];
    if (!items.length) {
      console.log("\n--apply: この鉄板商品はまだ深掘りリストに保存されていません。");
      return;
    }
    for (const it of items) {
      must(
        await sb
          .from("deepdive_items")
          .update({ unit_cost_cny: cheapest.price_cny, source_platform: "aliexpress", source_url: cheapest.url })
          .eq("id", it.id)
          .select("id")
      );
    }
    console.log(`\n--apply: 深掘りリスト${items.length}件に ${cheapest.price_cny}元 / ${cheapest.url} を反映しました。`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
