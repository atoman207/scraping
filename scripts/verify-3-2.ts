/**
 * 3-2 セラー深掘りの「正しさ」を確かめる。
 *   npm run verify:3-2 -- --seller 223868190 --sample 5
 *
 * ■ 何をしているか
 *   セラーページから集めたデータ(A)を、**商品ページの実物(B)** と1件ずつ突き合わせる。
 *
 *     A: セラーページを開いたときにブラウザが受け取る出品一覧レスポンス
 *        → lib/scraper/mercari-seller.ts が解釈している
 *     B: 商品ページを開いたときの商品詳細レスポンス
 *        → lib/scraper/mercari.ts の getItemDetail()
 *
 *   AとBは取得経路も解析コードも別物なので、両方が一致すれば
 *   「たまたま動いている」のではなく解釈が正しいと言える。
 *
 * ■ 見ている観点
 *   [1] 一覧    … 件数・上限・新しい順に並んでいるか・売却判定の内訳
 *   [2] 突合    … タイトル / 価格 / 売却 / 出品者 / 出品日時 / 発送方法
 *   [3] 実送料  … 取得できた件の金額が妥当か、取れなかった件の理由が仕様通りか
 *
 * ■ 商品ページを開く分だけアクセスが増えるので、標本は少なめ(既定5件)にしている。
 */
import "./_env";
import { parseArgs, argOne, requireArg } from "./_env";
import { MercariScraper } from "../lib/scraper/mercari";
import { BlockedError } from "../lib/scraper/types";
import type { ShipStatus } from "../lib/scraper/mercari-seller";

const args = parseArgs(process.argv.slice(2));
const maxItems = Number(argOne(args, "max") ?? 100);
const sample = Number(argOne(args, "sample") ?? 5);
const shippingTop = Number(argOne(args, "shipping") ?? 3);
const intervalMs = Number(argOne(args, "interval") ?? 5000);

function normalizeSellerId(input: string): string {
  const s = input.trim();
  const shops = s.match(/\/shops\/profile\/([^/?#]+)/);
  if (shops) return `shops:${shops[1]}`;
  const user = s.match(/\/user\/profile\/([^/?#]+)/);
  if (user) return user[1];
  return s;
}
const sellerExternalId = normalizeSellerId(requireArg(args, "seller"));

type FieldResult = { match: number; differ: number; unknown: number };
const F = (): FieldResult => ({ match: 0, differ: 0, unknown: 0 });

/**
 * 発送方法が一致しているか。
 * 一覧は配送方法マスタの名前そのまま(「ゆうゆうメルカリ便」)だが、商品ページは
 * 説明が付く(「ゆうゆうメルカリ便郵便局/コンビニ受取匿名配送」)。前方一致で吸収する。
 */
function shipMatches(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const n = (s: string) => s.replace(/\s+/g, "").replace(/[（(].*?[）)]/g, "");
  const [x, y] = [n(a), n(b)];
  return x.startsWith(y) || y.startsWith(x);
}

const SHIP_LABEL: Record<ShipStatus, string> = {
  got: "実送料を取得",
  fixed: "全国一律で確定",
  failed: "取れなかった",
  na: "仕様上取得不可",
  skip: "取得対象外",
};

async function main() {
  const started = Date.now();
  const scraper = new MercariScraper({ minIntervalMs: intervalMs, log: () => {} });
  await scraper.start();
  const problems: string[] = [];

  try {
    console.log(`\n=== 3-2 の精度検証 ===`);
    console.log(`  セラー: ${sellerExternalId} / 最大${maxItems}件 / 標本${sample}件\n`);

    // ---------------------------------------------------------------- [1]
    console.log(`[1] セラーページから出品一覧を取得します…`);
    const { profile, listings } = await scraper.fetchSeller(sellerExternalId, maxItems, {
      onProgress: (n) => console.log(`    … ${n}件`),
    });
    if (!listings.length) {
      console.log("  出品を取得できませんでした。セラーIDを確認してください。");
      process.exitCode = 1;
      return;
    }

    const sold = listings.filter((l) => l.status === "sold");
    console.log(`  セラー名: ${profile?.seller_name ?? "(取得できず)"}`);
    if (profile?.rating !== null && profile?.rating !== undefined) {
      console.log(`  ★評価: ${profile.rating} / 評価件数: ${profile.review_count?.toLocaleString() ?? "?"}件`);
    }
    console.log(`  取得: ${listings.length}件 (SOLD ${sold.length}件 / 販売中 ${listings.length - sold.length}件)`);
    if (profile?.listing_count !== null && profile?.listing_count !== undefined) {
      console.log(`  メルカリ側の総出品数(販売中): ${profile.listing_count.toLocaleString()}件`);
      console.log(`     ※ セラーページを手で開いて、この数と表示が合っていれば取得対象は正しい`);
    }

    // 上限を守っているか
    if (listings.length > maxItems) problems.push(`取得件数が上限を超えています (${listings.length} > ${maxItems})`);

    // 新しい順に並んでいるか
    const dated = listings.filter((l) => l.listed_at);
    let outOfOrder = 0;
    for (let i = 1; i < dated.length; i++) {
      if (Date.parse(dated[i - 1].listed_at!) < Date.parse(dated[i].listed_at!)) outOfOrder++;
    }
    console.log(
      `  並び順: 出品日時が取れた ${dated.length}件中、逆転 ${outOfOrder}件 ` +
        (outOfOrder === 0 ? "→ 新しい順" : "→ 新しい順になっていません")
    );
    if (outOfOrder > 0) problems.push(`新しい順に並んでいません (逆転${outOfOrder}件)`);
    if (!dated.length && !listings[0].is_shops) {
      problems.push("出品日時が1件も取れていません(回転日数を出せません)");
    }

    // 重複が無いか
    const uniq = new Set(listings.map((l) => l.external_id));
    if (uniq.size !== listings.length) problems.push(`同じ商品が重複しています (${listings.length - uniq.size}件)`);

    // 取引完了済みの件数。一覧レスポンスは古い出品の取引情報を省くので、
    // ここは「少なくともこれだけは完了している」という下限になる
    const shipped = listings.filter((l) => l.shipping_confirmed).length;
    const before = listings.filter((l) => l.before_shipping).length;
    console.log(`  発送済み: ${shipped}件以上 (一覧に出た分だけ) / 購入済みで未発送: ${before}件`);

    // ---------------------------------------------------------------- [2]
    const targets = listings.filter((l) => !l.is_shops).slice(0, Math.max(0, sample));
    if (targets.length) {
      console.log(`\n[2] ${targets.length}件の商品ページを開いて突き合わせます…`);
      console.log(`    (1件あたり約${(intervalMs / 1000).toFixed(0)}秒。全部で約${Math.round((targets.length * intervalMs) / 1000)}秒)\n`);
    } else {
      console.log(`\n[2] 突き合わせは省略します(メルカリShopsの商品ページは別の作りで、照合先がありません)`);
    }

    const fields = {
      タイトル: F(),
      価格: F(),
      売却: F(),
      出品者: F(),
      出品日時: F(),
      発送方法: F(),
    };
    const diffs: string[] = [];
    let fetched = 0;
    let failed = 0;

    for (const [i, a] of targets.entries()) {
      const b = await scraper.getItemDetail(a.external_id);
      if (!b) {
        failed++;
        console.log(`  [${i + 1}/${targets.length}] ${a.external_id} 商品ページを開けませんでした`);
        continue;
      }
      fetched++;
      const lines: string[] = [];
      const check = (name: keyof typeof fields, ok: boolean | null, detail: string) => {
        if (ok === null) fields[name].unknown++;
        else if (ok) fields[name].match++;
        else {
          fields[name].differ++;
          lines.push(`${name}: ${detail}`);
          diffs.push(`${a.external_id} ${name}: ${detail}`);
        }
      };

      check("タイトル", b.title === null ? null : b.title.trim() === a.title.trim(), `一覧「${a.title}」/ 商品ページ「${b.title}」`);
      check("価格", b.price === null ? null : b.price === a.price, `一覧 ¥${a.price} / 商品ページ ¥${b.price}`);
      check("売却", (a.status === "sold") === b.sold, `一覧 ${a.status} / 商品ページ ${b.sold ? "売り切れ" : "販売中"}`);
      check(
        "出品者",
        b.seller_external_id === null ? null : b.seller_external_id === a.seller_external_id,
        `一覧 ${a.seller_external_id} / 商品ページ ${b.seller_external_id}`
      );
      // 出品日時は秒まで一致するはず(どちらもレスポンス由来)。画面から読んだ場合は日付だけ比較
      check(
        "出品日時",
        !a.listed_at || !b.listed_at
          ? null
          : // どちらもレスポンス由来なら秒まで一致する。画面から読んだ場合は日付だけ比較
            b.listed_at.length > 10
            ? a.listed_at === b.listed_at
            : a.listed_at.slice(0, 10) === b.listed_at.slice(0, 10),
        `一覧 ${a.listed_at} / 商品ページ ${b.listed_at}`
      );
      check(
        "発送方法",
        !a.shipping_method || !b.shipping_method ? null : shipMatches(a.shipping_method, b.shipping_method),
        `一覧「${a.shipping_method}」/ 商品ページ「${b.shipping_method}」`
      );

      const mark = lines.length === 0 ? "OK  " : "差異";
      console.log(`  [${i + 1}/${targets.length}] ${mark} ${a.external_id}  ${a.title.slice(0, 26)}`);
      for (const l of lines) console.log(`         ${l}`);
    }

    if (fetched) {
      console.log(`\n=== 突き合わせ結果 (${fetched}件を照合${failed ? ` / ${failed}件は取得失敗` : ""}) ===\n`);
      console.log(`  項目        一致  相違  判定不能`);
      for (const [name, r] of Object.entries(fields)) {
        console.log(`  ${name.padEnd(10, "　").slice(0, 10)}  ${String(r.match).padStart(3)}  ${String(r.differ).padStart(3)}   ${String(r.unknown).padStart(3)}`);
      }
      for (const [name, r] of Object.entries(fields)) {
        if (r.differ > 0 && (name === "出品者" || name === "売却")) {
          problems.push(`${name}が商品ページと食い違っています (${r.differ}件)`);
        }
      }
    }

    // ---------------------------------------------------------------- [3]
    console.log(`\n[3] 実送料をSOLD上位${shippingTop}件について取得します…\n`);
    const tally = await scraper.fillRealShipping(listings, shippingTop, {
      onProgress: (done, total, r) => {
        const money = r.cost === null ? "—" : `¥${r.cost.toLocaleString()}`;
        console.log(`  [${done}/${total}] ${SHIP_LABEL[r.status]} ${money}  ${r.reason}`);
      },
    });

    console.log(
      `\n  内訳: 取得${tally.got}件 / 一律${tally.fixed}件 / 取れず${tally.failed}件 / 対象外${tally.na}件`
    );

    // 取れた金額が妥当か(メルカリの全国一律料金は160〜1,600円の範囲に収まる)
    for (const l of listings) {
      const cost = l.shipping_cost ?? null;
      if (l.ship_status === "got" && (cost === null || cost < 100 || cost > 5000)) {
        problems.push(`実送料が不自然です: ${l.external_id} = ${cost}`);
      }
      if (l.ship_status === "got" && !l.shipping_confirmed) {
        problems.push(`送料が未確定のはずなのに実送料が取れています: ${l.external_id}`);
      }
    }
    if (tally.failed > 0) {
      console.log(`  ※「取れず」はメルカリ便で取引完了済みなのに金額が出ないケース。`);
      console.log(`     数件なら非公開設定などで正常。全件がこれなら仕様変更を疑ってください。`);
    }

    // ---------------------------------------------------------------- 判定
    console.log(`\n=== 判定 ===`);
    if (!problems.length) {
      console.log(`  合格。セラーページから取れたデータは商品ページの実物と一致しています。`);
    } else {
      console.log(`  確認が必要な点があります:`);
      for (const p of problems.slice(0, 10)) console.log(`    ・${p}`);
      process.exitCode = 1;
    }
    if (diffs.length) {
      console.log(`\n  相違が出やすい正常なケース:`);
      console.log(`    ・価格 … 一覧を取得した後に値下げされた(時間差。数件なら正常)`);
      console.log(`    ・売却 … 照合中に売れた/購入がキャンセルされた`);
      console.log(`    ・発送方法 … 商品ページ側の文言に説明が付く場合(前方一致で吸収済み)`);
      console.log(`  出品者が食い違う場合は正常ではありません。解析コードの見直しが必要です。`);
    }
    console.log(`\n  所要 ${Math.round((Date.now() - started) / 1000)}秒\n`);
  } catch (e) {
    if (e instanceof BlockedError) {
      console.error(`\n[中断] ${e.message}\n  URL: ${e.url}`);
      console.error("  --interval を大きく(例: 8000)して時間をおいて再実行してください。");
      process.exitCode = 1;
    } else throw e;
  } finally {
    await scraper.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
