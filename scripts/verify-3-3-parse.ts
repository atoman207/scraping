/**
 * 3-3 の解析ロジックだけを、ネットワークなしで検証する。
 *   npm run test:3-3
 *
 * ここで使っているカードのテキストは、すべて **実際に AliExpress の検索結果から
 * 受け取ったもの**(2026-09時点)。ライブ検証(npm run verify:3-3)は実サイトを開くため
 * 時間がかかり、相手の在庫と広告枠に左右される。こちらは同じ入力に対して常に同じ
 * 結果になるので、「サイトが変わったのか、こちらのコードが壊れたのか」を切り分けられる。
 */
import {
  mercariPhotoUrls,
  parseAeCardText,
  scoreCandidate,
  toOriginalMercariImage,
  toSearchQuery,
} from "../lib/scraper/sourcing";
import { pickBest, rankCandidates } from "../lib/scraper/sourcing-run";
import type { SourcingCandidate } from "../lib/scraper/types";

let pass = 0;
let fail = 0;

function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  OK  " : "  NG  "} ${label}`);
  if (!ok) console.log(`         got=${JSON.stringify(got)}\n         want=${JSON.stringify(want)}`);
}

function ok(label: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "  OK  " : "  NG  "} ${label}${cond ? "" : `  ${detail}`}`);
}

// ============================================================ 1. 検索語
console.log("\n=== 1. タイトルから検索語を作る ===");

eq(
  "売り文句と記号を落とす",
  toSearchQuery("【新品未使用】折りたたみ スマホスタンド 送料無料 ★人気★"),
  "折りたたみ スマホスタンド"
);
eq("語順は元のタイトルのまま", toSearchQuery("ワイヤレス イヤホン 充電ケース付き", 3), "ワイヤレス イヤホン 充電ケース付き");
ok(
  "売り文句しか無いタイトルでも空にしない",
  toSearchQuery("新品未使用 送料無料").length > 0,
  `got=${JSON.stringify(toSearchQuery("新品未使用 送料無料"))}`
);
ok("長すぎるタイトルは60文字までに収める", toSearchQuery("あ".repeat(200) + " " + "い".repeat(200)).length <= 60);

// ============================================================ 2. カードの解析
console.log("\n=== 2. 検索結果カードの解析 ===");

// 実物その1: 割引・評価・販売数・新規向け割引つき(広告ではない)
const card1 = [
  "Magsafe 用磁気三脚携帯電話用三脚スマートフォン一脚ユニバーサルスタンドタコミニ三脚電話ホルダー用",
  "173円",
  "1,245円",
  "-86%",
  "4.8",
  "500+ 点販売",
  "ご新規さま1,072円お得",
  "類似特価品の中でベスト価格",
].join("\n");

const p1 = parseAeCardText(card1);
eq("売値は最初の金額行", p1.priceJpy, 173);
eq("定価は2つ目の金額行", p1.listPriceJpy, 1245);
eq("評価", p1.rating, 4.8);
eq("販売数", p1.orders, 500);
eq("広告ではない", p1.isAd, false);

// 実物その2: 「2点以上注文で1点あたり164円」という条件付き価格が混ざる広告カード
const card2 = [
  "折りたたみ式 ABS デスクトップ携帯電話スタンド iPad iPhone スマートフォンサポートタブレットデスク携帯電話ポータブルホルダーブラケット",
  "173円",
  "1,637円",
  "-89%",
  "4.9",
  "1,000+ 点販売",
  "2点以上注文で1点あたり164円",
  "ご新規さま1,464円お得",
  "広告",
].join("\n");

const p2 = parseAeCardText(card2);
eq("条件付きの金額を売値と取り違えない", p2.priceJpy, 173);
eq("販売数(カンマ区切り)", p2.orders, 1000);
eq("広告と判定する", p2.isAd, true);

// 実物その3: 割引が無く、価格が1つだけのカード
const card3 = ["ORICO アルミニウム 360 回転携帯電話ホルダー", "2,275円", "4.8", "110 点販売", "313円 お得"].join("\n");
const p3 = parseAeCardText(card3);
eq("価格が1つだけのとき定価はnull", [p3.priceJpy, p3.listPriceJpy], [2275, null]);
eq("「313円 お得」を価格として拾わない", p3.priceJpy, 2275);

// 価格が読めないカード(在庫切れなど)
const p4 = parseAeCardText("何かの商品名\n入荷待ち");
eq("価格が無ければnull", [p4.priceJpy, p4.rating, p4.orders], [null, null, null]);

// ============================================================ 3. 一致度
console.log("\n=== 3. 一致度 ===");

const mercari = "折りたたみ スマホスタンド 卓上 アルミ";
const near = scoreCandidate(mercari, "折りたたみ式 アルミ製 スマホスタンド 卓上 ホルダー");
const far = scoreCandidate(mercari, "犬用 首輪 レザー 大型犬");
ok(`似た商品のほうが高い (近い=${near} / 遠い=${far})`, near > far);
ok(`似た商品は40%以上 (=${near})`, near >= 40);
ok(`無関係な商品は40%未満 (=${far})`, far < 40);
eq("空文字は0", scoreCandidate("", "何か"), 0);

// ============================================================ 4. 並べ替えと最有力候補
console.log("\n=== 4. 並べ替えと最有力候補 ===");

function cand(over: Partial<SourcingCandidate>): SourcingCandidate {
  return {
    source_platform: "aliexpress",
    search_mode: "title",
    query: "テスト",
    external_id: null,
    title: "候補",
    price: null,
    currency: "JPY",
    price_jpy: null,
    price_cny: null,
    url: "https://ja.aliexpress.com/item/1.html",
    image_url: null,
    min_order_qty: 1,
    orders_count: null,
    rating: null,
    is_ad: false,
    match_score: 0,
    source_rank: null,
    ...over,
  };
}

const list: SourcingCandidate[] = [
  cand({ external_id: "A", url: "https://x/a", match_score: 80, price_cny: 30 }),
  cand({ external_id: "B", url: "https://x/b", match_score: 90, price_cny: 50 }),
  cand({ external_id: "C", url: "https://x/c", match_score: 95, price_cny: null }),
  cand({ external_id: "A", url: "https://x/a", match_score: 60, price_cny: 30, search_mode: "image", source_rank: 2 }),
  cand({ source_platform: "1688", search_mode: "link", url: "https://s.1688.com/x", match_score: null }),
];

const ranked = rankCandidates(list);
// 同じ商品が両方の探し方で出るのは「当たり」の強い証拠。画面でも別々に出すので、
// どちらの一覧にも残す(まとめるのは同じ探し方の中だけ)。
eq(
  "同じ商品が両方の探し方で出たら、どちらにも残す",
  ranked.filter((c) => c.external_id === "A").length,
  2
);
eq("タイトル検索は一致度の高い順に並ぶ", ranked.slice(0, 2).map((c) => c.external_id), ["B", "A"]);
eq("価格の無い商品は後ろへ", ranked[2].external_id, "C");
eq("画像検索はタイトル検索の後ろにまとめる", ranked[3].search_mode, "image");
eq("1688の検索リンクは最後", ranked[ranked.length - 1].search_mode, "link");

// 画像検索はサイトが返した順(=見た目の近い順)を守る。文字列の一致度では並べ替えない
const imageOnly = rankCandidates([
  cand({ external_id: "P", url: "https://x/p", search_mode: "image", source_rank: 3, match_score: 90, price_cny: 10 }),
  cand({ external_id: "Q", url: "https://x/q", search_mode: "image", source_rank: 1, match_score: 5, price_cny: 80 }),
  cand({ external_id: "R", url: "https://x/r", search_mode: "image", source_rank: 2, match_score: 50, price_cny: 40 }),
]);
eq(
  "画像検索は見た目の近い順(source_rank)を守る",
  imageOnly.map((c) => c.external_id),
  ["Q", "R", "P"]
);

const best = pickBest(ranked);
eq("最有力は一致度40%以上の中でいちばん安いもの", best?.external_id, "A");
eq("価格のある候補が無ければnull", pickBest([cand({ price_cny: null })]), null);

// 一致度がどれも低いときは、上位から安いものを選ぶ(何も返さないより手がかりになる)
const lowScores = rankCandidates([
  cand({ external_id: "D", url: "https://x/d", match_score: 10, price_cny: 90 }),
  cand({ external_id: "E", url: "https://x/e", match_score: 5, price_cny: 20 }),
]);
eq("一致度が低くても候補は出す", pickBest(lowScores)?.external_id, "E");

// 1688 は卸売で、同じ商品でも AliExpress(小売)より桁が1つ安い。
// 中国輸入の原価計算に使うのは1688なので、そちらを先に採る。
const withCn = rankCandidates([
  cand({ external_id: "AE", url: "https://x/ae", search_mode: "title", match_score: 90, price_cny: 20 }),
  cand({ external_id: "CN1", url: "https://x/c1", source_platform: "1688", search_mode: "image", source_rank: 1, price_cny: 9 }),
  cand({ external_id: "CN2", url: "https://x/c2", source_platform: "1688", search_mode: "image", source_rank: 2, price_cny: 5, photo_hits: 2 }),
  cand({ external_id: "CN3", url: "https://x/c3", source_platform: "1688", search_mode: "image", source_rank: 3, price_cny: 3 }),
]);
eq(
  "1688で複数の写真から一致した候補を最優先する",
  pickBest(withCn)?.external_id,
  "CN2"
);
eq(
  "1688が1件も無ければ AliExpress に戻る",
  pickBest(rankCandidates([cand({ external_id: "AE", url: "https://x/ae", match_score: 90, price_cny: 20 })]))?.external_id,
  "AE"
);
// 1688 のタイトル検索は、相手が返した順(関連度順)を守る
const cnTitleOrder = rankCandidates([
  cand({ external_id: "T3", url: "https://x/t3", source_platform: "1688", search_mode: "title", source_rank: 3, price_cny: 1 }),
  cand({ external_id: "T1", url: "https://x/t1", source_platform: "1688", search_mode: "title", source_rank: 1, price_cny: 9 }),
  cand({ external_id: "T2", url: "https://x/t2", source_platform: "1688", search_mode: "title", source_rank: 2, price_cny: 5 }),
]);
eq(
  "1688のキーワード検索は相手が返した順を守る(安い順に並べ替えない)",
  cnTitleOrder.map((c) => c.external_id),
  ["T1", "T2", "T3"]
);

// 画像検索しか無いときは、見た目がいちばん近い上位3件から選ぶ。
// 一致度で確かめられないので、それより下は当てにしない。
const imageBest = rankCandidates([
  cand({ external_id: "S", url: "https://x/s", search_mode: "image", source_rank: 1, price_cny: 60 }),
  cand({ external_id: "T", url: "https://x/t", search_mode: "image", source_rank: 2, price_cny: 30 }),
  cand({ external_id: "U", url: "https://x/u", search_mode: "image", source_rank: 3, price_cny: 45 }),
  // 4件目は見た目の近さが下位。いくら安くても自動では採らない
  cand({ external_id: "V", url: "https://x/v", search_mode: "image", source_rank: 9, price_cny: 1 }),
]);
eq("画像検索だけのときは上位3件から安いものを選ぶ", pickBest(imageBest)?.external_id, "T");

// ============================================================ 5. 画像URL
console.log("\n=== 5. 画像URLの読み替え ===");

eq(
  "メルカリのサムネイル → 元画像",
  toOriginalMercariImage("https://static.mercdn.net/thumb/item/webp/m83092432535_1.jpg?1788439023"),
  "https://static.mercdn.net/item/detail/orig/photos/m83092432535_1.jpg"
);
eq(
  "同じ出品の写真を3枚ぶん組み立てる(1枚目は渡されたURLのまま)",
  mercariPhotoUrls("https://static.mercdn.net/thumb/item/webp/m83092432535_1.jpg?1788439023", 3),
  [
    // 1枚目だけは、元画像が消えていてもサムネイルに落とせるよう渡されたURLを使う
    "https://static.mercdn.net/thumb/item/webp/m83092432535_1.jpg?1788439023",
    "https://static.mercdn.net/item/detail/orig/photos/m83092432535_2.jpg",
    "https://static.mercdn.net/item/detail/orig/photos/m83092432535_3.jpg",
  ]
);
eq(
  "枚数ぴったりを返す(同じ画像を2回検索しない)",
  mercariPhotoUrls("https://static.mercdn.net/thumb/item/webp/m83092432535_1.jpg", 2).length,
  2
);
eq(
  "メルカリ以外のURLはそのまま1枚だけ返す",
  mercariPhotoUrls("https://assets.mercari-shops-static.com/x.jpg", 3),
  ["https://assets.mercari-shops-static.com/x.jpg"]
);

eq(
  "メルカリShopsの画像は読み替えない(URLの作りが違う)",
  toOriginalMercariImage("https://assets.mercari-shops-static.com/-/small/plain/2JWHAwaGa49ZNLXTrFcstk.jpg@webp"),
  null
);

// ============================================================
console.log(`\n=== 結果: OK ${pass}件 / NG ${fail}件 ===\n`);
if (fail) process.exit(1);
