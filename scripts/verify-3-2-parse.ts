/**
 * 3-2 の解析ロジックだけを、ネットワークなしで検証する。
 *   npm run test:3-2
 *
 * ここで使っているレスポンスの断片は、すべて **実際にメルカリから受け取ったもの** を
 * 必要な項目だけに削ったもの(2026-09時点)。取得日時とセラーは検証に関係ないため、
 * 個人が特定される項目(セラー名など)は落としてある。
 *
 * ライブ検証(npm run verify:3-2)は実サイトを開くため時間がかかり、
 * 相手の在庫状況に左右される。こちらは同じ入力に対して常に同じ結果になるので、
 * 「サイトが変わったのか、こちらのコードが壊れたのか」を切り分けるのに使う。
 */
import {
  parseSellerItems,
  parseShopsProducts,
  parseShopProfile,
  parseUserProfile,
  realShippingOf,
  sortNewestFirst,
  type MercariGetItemsResponse,
  type MercariItemData,
} from "../lib/scraper/mercari-seller";
import { normalizeSellerId } from "../lib/scraper/seller-id";

let pass = 0;
let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  OK  " : "  NG  "} ${label}`);
  if (!ok) console.log(`         got=${JSON.stringify(got)}\n         want=${JSON.stringify(want)}`);
}

// ============================================================ 出品一覧
console.log("\n=== 1. 通常セラーの出品一覧 ===");

const itemsRes: MercariGetItemsResponse = {
  result: "OK",
  meta: { has_next: true },
  data: [
    {
      id: "m46719044146",
      status: "trading",
      name: "僕のヒーローアカデミア トガヒミコ",
      price: 1400,
      thumbnails: ["https://static.mercdn.net/thumb/item/jpeg/m46719044146_1.jpg"],
      created: 1787983341,
      updated: 1788426744,
      shipping_method_id: 14,
      item_category_ntiers: { id: 2648, name: "僕のヒーローアカデミア" },
      transaction_evidence: { status: "wait_shipping" },
      pager_id: 5784416006,
    },
    {
      id: "m18559579051",
      status: "sold_out",
      name: "COACH シグネチャー アップル柄 ポーチ",
      price: 2500,
      thumbnails: ["https://static.mercdn.net/thumb/item/jpeg/m18559579051_1.jpg"],
      created: 1787977014,
      updated: 1788412014,
      shipping_method_id: 14,
      item_category_ntiers: { id: 216, name: "ポーチ" },
      transaction_evidence: { status: "done" },
      pager_id: 5784397025,
    },
    {
      id: "m41016211257",
      status: "on_sale",
      name: "be Answer スカルプケアエッセンス 70mL 3本セット",
      price: 2500,
      created: 1787976770,
      updated: 1787976770,
      shipping_method_id: 9,
      pager_id: 5784396000,
    },
    // 出品者が非公開にした商品。セラーページの表示からは除かれる
    { id: "m99999999999", status: "sold_out", name: "非公開", price: 100, is_archived: true, created: 1787000000 },
    // 価格が壊れている行。黙って通さず除外する
    { id: "m88888888888", status: "sold_out", name: "壊れた行", price: NaN, created: 1787000000 },
  ],
};

const p = parseSellerItems(itemsRes, "223868190");
eq("読めた件数(非公開と壊れた行を除く)", p.items.length, 3);
eq("非公開の件数", p.archived, 1);
eq("形式不明で除外した件数", p.skipped, 1);
eq("続きがあるか", p.hasNext, true);
eq("続きを読むためのカーソル", p.lastPagerId, 5784396000);

const [trading, soldOut, onSale] = p.items;
eq("取引中は「売れた」に数える", trading.sold, true);
eq("売り切れは「売れた」に数える", soldOut.sold, true);
eq("販売中は「売れた」に数えない", onSale.sold, false);
eq("出品日時をISOに直す", soldOut.listed_at, "2026-08-29T04:16:54.000Z");
eq("最終更新日時をISOに直す", soldOut.updated_at, "2026-09-03T05:06:54.000Z");
eq("配送方法IDから名前を引く", soldOut.shipping_method, "らくらくメルカリ便");
eq("配送方法ID 9 は郵便", onSale.shipping_method, "郵便(定形、定形外、書留など)");
eq("商品URL", soldOut.listing_url, "https://jp.mercari.com/item/m18559579051");
eq("発送済みと分かっているか(done)", soldOut.shipping_confirmed, true);
eq("発送前と分かっているか(wait_shipping)", trading.before_shipping, true);
eq("販売中は取引情報が無いのでどちらでもない", [onSale.shipping_confirmed, onSale.before_shipping], [false, false]);

// 実行時にマスタが取れた場合はそちらが優先される
const withMaster = parseSellerItems(itemsRes, "223868190", { "14": "らくらくメルカリ便(新)" });
eq("実行時のマスタが優先される", withMaster.items[0].shipping_method, "らくらくメルカリ便(新)");

// 非公開も含める指定
eq("非公開を含めると1件増える", parseSellerItems(itemsRes, "223868190", {}, true).items.length, 4);

console.log("\n=== 2. 新しい順の並べ替え ===");
const shuffled = [p.items[2], p.items[0], p.items[1]];
eq(
  "出品日時の降順になる",
  sortNewestFirst(shuffled).map((i) => i.external_id),
  ["m46719044146", "m18559579051", "m41016211257"]
);
eq(
  "出品日時が無いものは後ろへ",
  sortNewestFirst([
    { ...p.items[0], listed_at: null },
    p.items[1],
  ]).map((i) => i.external_id),
  ["m18559579051", "m46719044146"]
);

console.log("\n=== 3. メルカリShopsの商品一覧 ===");
const shopsItems = parseShopsProducts(
  {
    products: [
      {
        name: "products/2JWHh674EqSrJDex8Noedz",
        displayName: "ブラウン シェーバー シリーズ5 5145S",
        price: 20280,
        inStock: false,
        createdAt: "2026-09-03T16:33:14Z",
        updatedAt: "2026-09-03T16:33:14Z",
        thumbnails: [{ uri: "https://assets.mercari-shops-static.com/x.jpg" }],
        details: { category: { name: "categories/ikuHLQ742BuWqCuqwmGiGA" } },
      },
      { name: "products/2JWHgyFLp8D2qgS7XoL94v", displayName: "在庫あり", price: 2310, inStock: true, createdAt: "2026-09-02T10:00:00Z" },
      { name: "", displayName: "IDが無い行", price: 100 },
    ],
    nextPageToken: "F/+BBAEBBkN1cnNvcg",
  },
  "shops:waKfjvmcR3eg7r4eL3xS8b"
);
eq("読めた件数", shopsItems.items.length, 2);
eq("IDが無い行は除外", shopsItems.skipped, 1);
eq("商品ID", shopsItems.items[0].external_id, "2JWHh674EqSrJDex8Noedz");
eq("商品URL", shopsItems.items[0].listing_url, "https://jp.mercari.com/shops/product/2JWHh674EqSrJDex8Noedz");
eq("在庫なしは売り切れ扱い", shopsItems.items[0].sold, true);
eq("在庫ありは販売中", shopsItems.items[1].sold, false);
eq("Shopsは実送料の取得対象にしない", shopsItems.items[0].shipping_confirmed, false);
eq("続きのトークン", shopsItems.nextPageToken, "F/+BBAEBBkN1cnNvcg");

console.log("\n=== 4. プロフィール ===");

// プロフィール画像を設定しているセラー
const withPhoto = parseUserProfile(
  {
    result: "OK",
    data: {
      id: 223868190,
      name: "しずく",
      photo_url: "https://static.mercdn.net/item/detail/orig/photos/abc.jpg",
      photo_thumbnail_url: "https://static.mercdn.net/thumb/photos/abc_1.jpg",
      num_ratings: 106,
      star_rating_score: 4.5,
      num_sell_items: 60,
      ratings: { good: 104, normal: 0, bad: 2 },
      created: 1661582688,
    },
  },
  "223868190"
);
eq("通常セラー", withPhoto, {
  platform: "mercari",
  seller_external_id: "223868190",
  seller_name: "しずく",
  rating: 4.5,
  review_count: 106,
  profile_url: "https://jp.mercari.com/user/profile/223868190",
  // 一覧では小さく出すので、サムネイル版を優先する
  avatar_url: "https://static.mercdn.net/thumb/photos/abc_1.jpg",
  listing_count: 60,
  good_ratings: 104,
  bad_ratings: 2,
  registered_at: "2022-08-27T06:44:48.000Z",
});

// 画像を設定していないセラー。メルカリは全員に同じ既定画像を返すので、
// そのまま出すと一覧で見分けがつかない。null にして画面側で頭文字を出す
eq(
  "既定画像はアバター無しとして扱う",
  parseUserProfile(
    {
      result: "OK",
      data: {
        name: "しずく",
        photo_url: "https://static.mercdn.net/images/member_photo_noimage.png",
        photo_thumbnail_url: "https://static.mercdn.net/images/member_photo_noimage_thumb.png",
      },
    },
    "1"
  )?.avatar_url,
  null
);

eq("名前が無ければ null", parseUserProfile({ result: "OK", data: {} }, "1"), null);
eq(
  "メルカリShops",
  parseShopProfile(
    {
      shopInfo: {
        id: "waKf",
        name: "Sundear　メルカリ店",
        thumbnailUri: "https://assets.mercari-shops-static.com/-/small/plain/logo.jpg",
        createdAt: "1707483754",
      },
      shopReviewStats: { score: 5, count: 2105 },
    },
    "shops:waKf"
  ),
  {
    platform: "mercari",
    seller_external_id: "shops:waKf",
    seller_name: "Sundear　メルカリ店",
    rating: 5,
    review_count: 2105,
    profile_url: "https://jp.mercari.com/shops/profile/waKf",
    avatar_url: "https://assets.mercari-shops-static.com/-/small/plain/logo.jpg",
    listing_count: null,
    good_ratings: null,
    bad_ratings: null,
    registered_at: "2024-02-09T13:02:34.000Z",
  }
);

// ============================================================ 実送料
console.log("\n=== 5. 実送料の判定 ===");

/** 実際の商品詳細レスポンスから、判定に使う項目だけ取り出したもの */
const item = (o: Partial<MercariItemData>): MercariItemData => ({ shipping_payer: { id: 2, code: "seller", name: "送料込み(出品者負担)" }, ...o });

// 発送済み: shipping_class に実額が入る
const got = realShippingOf(
  item({
    status: "sold_out",
    shipping_method: { id: 14, name: "らくらくメルカリ便" },
    shipping_class: { id: 1, name: "ネコポス", fee: 210, shipping_fee: 210, total_fee: 210, pickup_fee: 0, carrier: "yamato" },
    transaction_evidence: { id: 2326274331, status: "done" },
  })
);
eq("取引完了済み → 実送料を取得", [got.status, got.cost, got.ship_class], ["got", 210, "ネコポス"]);

// 評価待ち(発送済み)。取引完了を待たずに送料は確定している
const waitReview = realShippingOf(
  item({
    status: "trading",
    shipping_method: { id: 17, name: "ゆうゆうメルカリ便" },
    shipping_class: { id: 38, name: "ゆうパケットポストmini", fee: 160, total_fee: 160 },
    transaction_evidence: { id: 2328747663, status: "wait_review" },
  })
);
eq("発送済み(評価待ち) → 実送料を取得", [waitReview.status, waitReview.cost], ["got", 160]);

// 発送待ち: shipping_class は id=0・fee=0 の空箱
const waitShipping = realShippingOf(
  item({
    status: "trading",
    shipping_method: { id: 14, name: "らくらくメルカリ便" },
    shipping_class: { id: 0, fee: 0, shipping_fee: 0, total_fee: 0, pickup_fee: 0 },
    transaction_evidence: { id: 2330340611, status: "wait_shipping" },
  })
);
eq("発送前 → 取得不可", [waitShipping.status, waitShipping.cost], ["na", null]);

// 販売中: 取引そのものが無い
const onSaleShip = realShippingOf(
  item({
    status: "on_sale",
    shipping_method: { id: 14, name: "らくらくメルカリ便" },
    shipping_class: { id: 0, fee: 0, total_fee: 0 },
  })
);
eq("販売中 → 取得不可", [onSaleShip.status, onSaleShip.cost], ["na", null]);

// 定形外・普通郵便: 取引が完了していても金額は公開されない(仕様書の想定どおり)
const teikeigai = realShippingOf(
  item({
    status: "sold_out",
    shipping_method: { id: 9, name: "郵便（定型、定形外、書留など）" },
    shipping_class: { id: 0, fee: 0, shipping_fee: 0, total_fee: 0, pickup_fee: 0 },
    transaction_evidence: { status: "done" },
  })
);
eq("定形外・普通郵便 → 取得不可", [teikeigai.status, teikeigai.cost], ["na", null]);

// クリックポストは全国一律なので、発送前でも金額が確定している
const clickpost = realShippingOf(item({ status: "sold_out", shipping_method: { id: 13, name: "クリックポスト" } }));
eq("クリックポスト → 全国一律185円", [clickpost.status, clickpost.cost], ["fixed", 185]);

// 着払いは購入者負担。出品者の送料は0円(推定値を入れると原価がズレる)
const chakubarai = realShippingOf({
  status: "sold_out",
  shipping_payer: { id: 1, code: "buyer", name: "着払い(購入者負担)" },
  shipping_method: { id: 4, name: "ゆうパック" },
  transaction_evidence: { status: "done" },
});
eq("着払い → 出品者負担は0円", [chakubarai.status, chakubarai.cost], ["fixed", 0]);

// メルカリ便で発送済みなのに金額が無い = 本来取れるはずが取れなかった
const broken = realShippingOf(
  item({ status: "sold_out", shipping_method: { id: 14, name: "らくらくメルカリ便" }, transaction_evidence: { status: "done" } })
);
eq("メルカリ便なのに金額が無い → 取れなかった", [broken.status, broken.cost], ["failed", null]);

// 商品情報そのものが読めなかった
eq("商品情報が読めない → 取れなかった", realShippingOf(null).status, "failed");

// 画面から読んだ場合(配送方法IDが無い)も、名前でメルカリ便と判定できる
const fromDom = realShippingOf({
  shipping_method: { name: "らくらくメルカリ便" },
  transaction_evidence: { status: "done" },
});
eq("画面から読んだメルカリ便 → 取れなかった", fromDom.status, "failed");

// ============================================================ セラーIDの正規化
//
// 画面(/api/scrape)・ジョブAPI(/api/jobs)・CLI の3つの入口が同じ関数を通す。
// ここがずれると、同じセラーを別人として2回登録してしまう。
console.log("\n=== 6. セラーIDの正規化 ===");

eq("数字のIDはそのまま", normalizeSellerId("223868190"), "223868190");
eq("前後の空白を落とす", normalizeSellerId("  223868190 "), "223868190");
eq(
  "プロフィールURL → ID",
  normalizeSellerId("https://jp.mercari.com/user/profile/223868190"),
  "223868190"
);
eq(
  "クエリ付きのURL → ID",
  normalizeSellerId("https://jp.mercari.com/user/profile/223868190?afid=123"),
  "223868190"
);
eq(
  "ShopsのURL → shops: 付きのID",
  normalizeSellerId("https://jp.mercari.com/shops/profile/waKfjvmcR3eg7r4eL3xS8b"),
  "shops:waKfjvmcR3eg7r4eL3xS8b"
);
eq("shops: 付きのIDはそのまま", normalizeSellerId("shops:waKfjvmcR3eg7r4eL3xS8b"), "shops:waKfjvmcR3eg7r4eL3xS8b");
eq("空文字は空文字(呼び出し側でエラーにする)", normalizeSellerId("   "), "");

console.log(`\n===== 結果: ${pass}件OK / ${fail}件NG =====\n`);
process.exit(fail ? 1 : 0);
