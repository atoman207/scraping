/**
 * 1688Japan のセッションが生きているかを確かめる。
 *   npm run test:1688jp
 *   npm run test:1688jp -- --keyword 链条锁
 *   npm run test:1688jp -- --image https://static.mercdn.net/item/detail/orig/photos/mXXXX_1.jpg
 *
 * ■ なぜ要るか
 *   1688 の候補はこのセッション頼みで、切れると黙って0件になる。
 *   「相手が変わったのか、ログインが切れただけなのか」をすぐ切り分けられるようにする。
 *   定期的に叩いて、切れていたら `npm run login:1688jp` で入り直す運用を想定している。
 */
import "./_env";
import { argOne, parseArgs } from "./_env";
import { sessionPath, Sourcing1688Jp } from "../lib/scraper/sourcing-1688jp";

const args = parseArgs(process.argv.slice(2));

async function main() {
  console.log(`\nセッション: ${sessionPath()}`);

  const check = await Sourcing1688Jp.check();
  if (!check.ok) {
    console.log(`  NG  ${check.reason}`);
    process.exit(1);
  }
  console.log(`  OK  ${check.user} としてログインできています`);

  const jp = new Sourcing1688Jp({ limit: 5, log: (m) => console.log(m) });

  const keyword = argOne(args, "keyword") ?? "链条锁";
  console.log(`\n=== キーワード検索「${keyword}」 ===`);
  const byKeyword = await jp.searchByKeyword(keyword);
  console.log(`  ${byKeyword.length}件`);
  for (const c of byKeyword.slice(0, 3)) {
    console.log(
      `    ${String(c.price_cny).padStart(7)}元  販売${String(c.orders_count ?? "-").padStart(5)}` +
        `  リピート${String(c.repeat_rate ?? "-").padStart(6)}%  ${c.title.slice(0, 34)}`
    );
  }
  if (!byKeyword.length) {
    console.log("  NG  キーワード検索が0件でした(相手の作りが変わった可能性)");
    process.exit(1);
  }

  const image = argOne(args, "image");
  if (image) {
    console.log(`\n=== 画像検索 ===`);
    const byImage = await jp.searchByPhoto(image);
    console.log(`  ${byImage.length}件`);
    for (const c of byImage.slice(0, 3)) {
      console.log(`    ${String(c.price_cny).padStart(7)}元  ${c.title.slice(0, 40)}`);
    }
    if (!byImage.length) {
      console.log("  NG  画像検索が0件でした");
      process.exit(1);
    }
  } else {
    console.log("\n(--image <メルカリの画像URL> を付けると、画像検索も確かめます)");
  }

  console.log("\n  すべて問題ありません。\n");
}

main().catch((e) => {
  console.error(`\n  NG  ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
