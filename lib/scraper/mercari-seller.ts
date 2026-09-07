/**
 * 発注仕様書 3-2: セラー深掘り のデータ解釈部(ブラウザに依存しない純粋関数)。
 *
 * 3-1(mercari-search.ts)と同じ考え方で、**セラーページ/商品ページを普通に開いた結果として
 * ブラウザが受け取ったレスポンス** を読む。こちらから内部APIを叩くのではないので、
 * アクセス回数は「ページを開く回数」と「利用者がスクロールしたときの追加読み込み」だけ。
 *
 * なぜDOMではなくレスポンスを読むのか:
 *   セラーページの一覧DOMには、タイトル・価格・売り切れバッジしか出ない。
 *   出品日時・最終更新日時・配送方法・取引状態はDOMに存在しないため、
 *   DOMだけでは「回転日数」も「実送料の取得可否」も判定できない。
 *   一方、ページが描画のために受け取っているレスポンスにはこれらが最初から入っている。
 *
 * 実際に確認した取得元(2026-09時点):
 *   通常セラー   /user/profile/<id>
 *                 └ users/get_profile?user_id=<id>   … 名前・評価・出品数
 *                 └ items/get_items?seller_id=<id>&limit=30&status=on_sale,trading,sold_out
 *                                                    … 出品一覧。続きは max_pager_id で送る
 *   メルカリShops /shops/profile/<id>
 *                 └ bff/shops/v1/contents/shops/<id> … 店名・レビュー
 *                 └ bff/shops/v1/shops/<id>/products … 商品一覧。続きは pageToken で送る
 *   商品ページ    /item/<id>
 *                 └ items/get?id=<id>                … shipping_class に**実送料**が入る
 */
import type { ScrapedSeller } from "./types";
import { SHIPPING_METHOD_FALLBACK } from "./mercari-search";

// ---------------------------------------------------------------- 出品一覧

/** セラーページが受け取る出品1件(必要な項目のみ) */
export type MercariUserItem = {
  id: string;
  seller?: { id: number | string; name?: string };
  /** on_sale | trading | sold_out */
  status: string;
  name: string;
  price: number;
  thumbnails?: string[];
  /** UNIX秒(数値) */
  created?: number;
  updated?: number;
  shipping_method_id?: number;
  item_category_ntiers?: { id?: number; name?: string; root_category_id?: number };
  parent_categories_ntiers?: { id?: number; name?: string }[];
  /** 取引の状態。done=取引完了済み、wait_shipping等=取引中 */
  transaction_evidence?: { id?: number; status?: string } | null;
  /** 出品者が非公開にした商品。セラーページ本体の表示からは除かれる */
  is_archived?: boolean;
  /** 続きを読むときのカーソル(最後の1件の値を max_pager_id に渡す) */
  pager_id?: number;
};

export type MercariGetItemsResponse = {
  result?: string;
  meta?: { has_next?: boolean };
  data?: MercariUserItem[];
};

/** メルカリShopsの商品1件 */
export type ShopsProduct = {
  /** "products/<商品ID>" 形式 */
  name?: string;
  displayName?: string;
  price?: number;
  /** 在庫あり=販売中。false は売り切れ(または在庫切れ) */
  inStock?: boolean;
  /** ISO日時 */
  createdAt?: string;
  updatedAt?: string;
  thumbnails?: { uri?: string }[];
  details?: { category?: { name?: string } };
};

export type ShopsProductsResponse = {
  products?: ShopsProduct[];
  nextPageToken?: string;
};

/** 一覧から取り出した1出品ぶんの生データ(3-1の SearchItem と同じ形をなぞっている) */
export type SellerItem = {
  external_id: string;
  seller_external_id: string;
  title: string;
  price: number;
  /** 売れたか(取引中を含む。3-1の isSoldStatus と同じ考え方) */
  sold: boolean;
  status_raw: string;
  /** 出品日時(ISO) */
  listed_at: string | null;
  /** 最終更新日時(ISO)。売却日時そのものではないが回転日数の推定に使う */
  updated_at: string | null;
  shipping_method_id: string | null;
  shipping_method: string | null;
  category_id: string | null;
  image_url: string | null;
  listing_url: string;
  is_shops: boolean;
  /**
   * 一覧の時点で「発送済み(＝送料が確定している)」と分かっているか。
   *
   * 注意: これは**取りこぼす側に倒れる目安**でしかない。一覧レスポンスの取引情報は
   * 古い出品では省かれることがあり、実際には発送済みなのに false になる
   * (商品ページを開けば正しく分かる)。実送料を取りに行く順番を決めるのに使い、
   * 「false だから取れない」と判断するのには使わない。
   */
  shipping_confirmed: boolean;
  /**
   * 購入されたが、まだ発送されていない(支払待ち・発送待ち)か。
   * この状態は送料が確定していないので、実送料を取りに行く優先度を下げる。
   */
  before_shipping: boolean;
  /** 続きを読むためのカーソル(通常セラーのみ) */
  pager_id: number | null;
};

/**
 * 取引の状態のうち「すでに発送された」もの。
 *
 * 実送料が確定するのは**発送された時点**で、取引完了(評価まで済む)を待たない。
 * done=完了 / wait_review=発送済みで評価待ち。
 * これより手前(wait_payment=支払待ち, wait_shipping=発送待ち)はまだ確定していない。
 *
 * ただし金額そのものの判断にこの一覧を使ってはいけない(メルカリ側の語彙が増えると
 * 追随できないため)。金額は商品詳細の shipping_class が入っているかで判断し、
 * こちらは「どれから取りに行くか」の優先度にだけ使う。
 */
export const SHIPPED_TRANSACTION_STATUSES = new Set(["done", "wait_review"]);

/**
 * セラーページの出品一覧レスポンスで「売れた」とみなすか。
 *
 * 3-1 と同じ判断: sold_out(取引完了) と trading(購入済み・取引中) は
 * 画面上どちらも「売り切れ」で、**購入されたという事実は同じ**なので両方を売却として数える。
 */
export function isSoldUserStatus(status: string): boolean {
  return status === "sold_out" || status === "trading";
}

/** UNIX秒(数値) → ISO日時。取れなければ null */
export function unixSecToIso(v: number | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** ISO文字列を正規化する。壊れていれば null */
function isoOrNull(v: string | undefined | null): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function itemUrlOfId(id: string, isShops: boolean): string {
  return isShops
    ? `https://jp.mercari.com/shops/product/${id}`
    : `https://jp.mercari.com/item/${id}`;
}

/**
 * 通常セラーの出品一覧レスポンス1ページぶんを SellerItem[] に直す。
 *
 * @param includeArchived 出品者が非公開にした商品も含めるか。
 *        既定 false。セラーページの表示(exclude_archived_item=true)に合わせるため。
 */
export function parseSellerItems(
  res: MercariGetItemsResponse,
  sellerExternalId: string,
  shippingMethods: Record<string, string> = {},
  includeArchived = false
): { items: SellerItem[]; hasNext: boolean; lastPagerId: number | null; skipped: number; archived: number } {
  const out: SellerItem[] = [];
  let skipped = 0;
  let archived = 0;
  for (const it of res.data ?? []) {
    if (!it?.id || typeof it.price !== "number" || !Number.isFinite(it.price)) {
      skipped++;
      continue;
    }
    if (it.is_archived) {
      archived++;
      if (!includeArchived) continue;
    }
    const smId =
      it.shipping_method_id === undefined || it.shipping_method_id === null
        ? null
        : String(it.shipping_method_id);
    out.push({
      external_id: it.id,
      seller_external_id: sellerExternalId,
      title: it.name ?? "",
      price: it.price,
      sold: isSoldUserStatus(it.status),
      status_raw: it.status,
      listed_at: unixSecToIso(it.created),
      updated_at: unixSecToIso(it.updated),
      shipping_method_id: smId,
      shipping_method: smId ? (shippingMethods[smId] ?? SHIPPING_METHOD_FALLBACK[smId] ?? null) : null,
      category_id: it.item_category_ntiers?.id !== undefined ? String(it.item_category_ntiers.id) : null,
      image_url: it.thumbnails?.[0] ?? null,
      listing_url: itemUrlOfId(it.id, false),
      is_shops: false,
      shipping_confirmed: SHIPPED_TRANSACTION_STATUSES.has(it.transaction_evidence?.status ?? ""),
      before_shipping:
        Boolean(it.transaction_evidence?.status) &&
        !SHIPPED_TRANSACTION_STATUSES.has(it.transaction_evidence?.status ?? ""),
      pager_id: typeof it.pager_id === "number" ? it.pager_id : null,
    });
  }
  const last = out.length ? out[out.length - 1].pager_id : null;
  return { items: out, hasNext: Boolean(res.meta?.has_next), lastPagerId: last, skipped, archived };
}

/**
 * メルカリShopsの商品一覧レスポンスを SellerItem[] に直す。
 *
 * Shopsは通常出品と作りが違い、取れる項目が少ない:
 *   - 売却の判定は inStock(在庫あり/なし)のみ。個別の取引状態は公開されていない
 *   - 配送方法・実送料は店舗側の契約で、商品ページにも出ない
 */
export function parseShopsProducts(
  res: ShopsProductsResponse,
  sellerExternalId: string
): { items: SellerItem[]; nextPageToken: string | null; skipped: number } {
  const out: SellerItem[] = [];
  let skipped = 0;
  for (const p of res.products ?? []) {
    const id = (p?.name ?? "").split("/").filter(Boolean).pop() ?? "";
    if (!id || typeof p.price !== "number" || !Number.isFinite(p.price)) {
      skipped++;
      continue;
    }
    out.push({
      external_id: id,
      seller_external_id: sellerExternalId,
      title: p.displayName ?? "",
      price: p.price,
      // Shopsは「在庫なし = 売り切れ」。取引中という状態は公開されていない
      sold: p.inStock === false,
      status_raw: p.inStock === false ? "sold_out" : "on_sale",
      listed_at: isoOrNull(p.createdAt),
      updated_at: isoOrNull(p.updatedAt),
      shipping_method_id: null,
      shipping_method: null,
      category_id: (p.details?.category?.name ?? "").split("/").filter(Boolean).pop() ?? null,
      image_url: p.thumbnails?.[0]?.uri ?? null,
      listing_url: itemUrlOfId(id, true),
      is_shops: true,
      // Shopsは取引単位の情報が無いので、実送料の取得対象にはしない
      shipping_confirmed: false,
      before_shipping: false,
      pager_id: null,
    });
  }
  return { items: out, nextPageToken: res.nextPageToken || null, skipped };
}

/** 新しい順(出品日時の降順)に並べ替える。日時が無いものは後ろへ */
export function sortNewestFirst(items: SellerItem[]): SellerItem[] {
  return [...items].sort((a, b) => {
    const ta = a.listed_at ? Date.parse(a.listed_at) : -1;
    const tb = b.listed_at ? Date.parse(b.listed_at) : -1;
    if (tb !== ta) return tb - ta;
    return a.external_id < b.external_id ? 1 : -1;
  });
}

// ---------------------------------------------------------------- プロフィール

export type MercariProfileResponse = {
  result?: string;
  data?: {
    id?: number | string;
    name?: string;
    /** プロフィール画像。設定していないセラーは member_photo_noimage.png になる */
    photo_url?: string;
    photo_thumbnail_url?: string;
    num_ratings?: number;
    star_rating_score?: number;
    num_sell_items?: number;
    ratings?: { good?: number; normal?: number; bad?: number };
    is_official?: boolean;
    created?: number;
  };
};

/** セラーのプロフィール。出品総数は画面の「総出品数」表示に使う */
export type SellerProfile = ScrapedSeller & {
  listing_count: number | null;
  /** 良い評価の件数。取れなければ null */
  good_ratings?: number | null;
  /** 悪い評価の件数。取れなければ null */
  bad_ratings?: number | null;
  /** 出品者としての登録日(ISO)。取れなければ null */
  registered_at?: string | null;
};

/**
 * メルカリが「画像なし」に使う既定画像。
 * これをそのまま出すと全員同じ灰色アイコンが並んで見分けがつかないので、
 * 画面側で頭文字アバターに差し替えられるよう null にして返す。
 */
const NO_PHOTO = /member_photo_noimage/;

function avatarOrNull(...candidates: (string | undefined | null)[]): string | null {
  for (const c of candidates) {
    if (c && !NO_PHOTO.test(c)) return c;
  }
  return null;
}

/** 通常セラーのプロフィールレスポンス → ScrapedSeller */
export function parseUserProfile(
  res: MercariProfileResponse,
  sellerExternalId: string,
  platform = "mercari"
): SellerProfile | null {
  const d = res?.data;
  const name = (d?.name ?? "").trim();
  if (!name) return null;
  return {
    platform,
    seller_external_id: sellerExternalId,
    seller_name: name,
    rating: typeof d?.star_rating_score === "number" ? d.star_rating_score : null,
    review_count: typeof d?.num_ratings === "number" ? d.num_ratings : null,
    profile_url: `https://jp.mercari.com/user/profile/${sellerExternalId}`,
    // 一覧では小さく出すので、あればサムネイル版を優先する(転送量が軽い)
    avatar_url: avatarOrNull(d?.photo_thumbnail_url, d?.photo_url),
    listing_count: typeof d?.num_sell_items === "number" ? d.num_sell_items : null,
    good_ratings: typeof d?.ratings?.good === "number" ? d.ratings.good : null,
    bad_ratings: typeof d?.ratings?.bad === "number" ? d.ratings.bad : null,
    registered_at: unixSecToIso(d?.created),
  };
}

export type ShopsContentsResponse = {
  shopInfo?: { id?: string; name?: string; thumbnailUri?: string; createdAt?: string };
  shopReviewStats?: { score?: number; count?: number };
};

/** メルカリShopsの店舗情報レスポンス → ScrapedSeller */
export function parseShopProfile(
  res: ShopsContentsResponse,
  sellerExternalId: string,
  platform = "mercari"
): SellerProfile | null {
  const name = (res?.shopInfo?.name ?? "").trim();
  if (!name) return null;
  const shopId = sellerExternalId.startsWith("shops:") ? sellerExternalId.slice(6) : sellerExternalId;
  const created = res.shopInfo?.createdAt;
  return {
    platform,
    seller_external_id: sellerExternalId,
    seller_name: name,
    rating: typeof res.shopReviewStats?.score === "number" ? res.shopReviewStats.score : null,
    review_count: typeof res.shopReviewStats?.count === "number" ? res.shopReviewStats.count : null,
    profile_url: `https://jp.mercari.com/shops/profile/${shopId}`,
    avatar_url: avatarOrNull(res.shopInfo?.thumbnailUri),
    listing_count: null,
    good_ratings: null,
    bad_ratings: null,
    // Shopsの createdAt はUNIX秒の文字列で来る
    registered_at: created ? unixSecToIso(Number(created)) : null,
  };
}

// ---------------------------------------------------------------- 実送料

/** 商品ページが受け取る商品詳細(必要な項目のみ) */
export type MercariItemData = {
  id?: string;
  name?: string;
  price?: number;
  /** on_sale | trading | sold_out */
  status?: string;
  created?: number;
  updated?: number;
  seller?: { id?: number | string; name?: string };
  item_condition?: { id?: number; name?: string };
  shipping_payer?: { id?: number; name?: string; code?: string };
  shipping_method?: { id?: number; name?: string };
  /**
   * **実送料**。発送時に確定したサイズ区分と金額が入る。
   * 取引が完了していない/メルカリ便以外だと id=0・fee=0 の空箱が返る。
   */
  shipping_class?: {
    id?: number;
    name?: string;
    fee?: number;
    shipping_fee?: number;
    total_fee?: number;
    pickup_fee?: number;
    carrier?: string;
  } | null;
  transaction_evidence?: { id?: number; status?: string } | null;
  /** メルカリShopsの商品か。真偽値ではなく "yes"/"no" の文字列で来る */
  is_shop_item?: boolean | string;
};

export type MercariItemGetResponse = { result?: string; data?: MercariItemData };

/**
 * メルカリShopsの商品か。
 * この項目は真偽値ではなく "yes"/"no" の**文字列**で来るため、そのまま真偽判定すると
 * "no" も真になってしまう(通常出品が全部Shops扱いになる)。明示的に判定する。
 */
export function isShopItem(v: boolean | string | undefined | null): boolean {
  return v === true || v === "yes";
}

/**
 * 実送料の取得結果。
 *
 * 「取れなかった」と「そもそも対象外」を区別する。
 * 画面では前者を「(送料待ち)」、後者を「—」として出し分けられる。
 */
export type ShipStatus =
  /** 実送料を取得できた(発送時に確定した金額) */
  | "got"
  /** 全国一律料金の配送方法なので金額が確定している(クリックポスト等) */
  | "fixed"
  /** 取りに行ったが金額が公開されていなかった(取れるはずが取れなかった) */
  | "failed"
  /** 仕様上そもそも金額が決まらない(普通郵便・定形外・未定・取引未完了・Shops) */
  | "na"
  /** そのモードでは取得対象にしていない(呼び出し側が付ける) */
  | "skip";

export type RealShipping = {
  /** 出品者が負担した送料(円)。取得できなければ null */
  cost: number | null;
  status: ShipStatus;
  /** 配送方法名(「らくらくメルカリ便」など) */
  method: string | null;
  /** 発送時に確定したサイズ区分名(「ネコポス」など)。取れたときだけ入る */
  ship_class: string | null;
  /**
   * 商品ページで見た取引の状態(done / wait_review / wait_shipping / wait_payment など)。
   * 生の値をそのまま入れてある。取れなければ null。
   */
  transaction_status: string | null;
  /**
   * 送料が確定しているか(商品ページで見た確定値)。
   * 一覧レスポンス側の同名フラグは取りこぼすので、判断にはこちらを使う。
   */
  shipping_confirmed: boolean;
  /** 人間向けの理由。ログと画面の説明にそのまま使える */
  reason: string;
};

/**
 * 名前だけで全国一律の金額が確定する配送方法。
 *
 * ここに入れてよいのは「サイズや重量によらず1つの金額しか無いもの」だけ。
 * レターパック(ライト/プラス)・ゆうメール(重量制)・ゆうパック(サイズ制)は
 * 名前だけでは金額が決まらないので入れない。
 */
export const FIXED_FEE_BY_METHOD: [RegExp, number][] = [[/クリックポスト/, 185]];

/** 配送方法IDのうち、メルカリが集荷・配送を担当する = 実送料が公開されるもの */
const MERCARI_SHIPPING_METHOD_IDS = new Set(["14", "16", "17", "18", "19", "20"]);

/**
 * 商品詳細から実送料を判定する。
 *
 * ■ 判定の軸は「発送されたか」であって「取引が完了したか」ではない。
 *   送料はメルカリが集荷した時点で確定し、その内容が shipping_class に入る。
 *   評価がまだ済んでいなくても(wait_review)金額は確定している。
 *   逆に、支払待ち・発送待ちの段階では shipping_class は id=0・fee=0 の空箱になる。
 *   そのため**金額の有無そのもの**を根拠にし、取引状態の文字列は理由の説明にだけ使う。
 *   (メルカリ側の状態の語彙が増えても、金額の判定が壊れないようにするため)
 *
 * ■ 仕様書 3-2 の「普通郵便・定形外・取引未完了などは取得不可でよい」に対応して、
 *   取得できない場合は理由つきで cost=null を返す。
 */
export function realShippingOf(d: MercariItemData | null | undefined): RealShipping {
  const method = d?.shipping_method?.name ?? null;
  const methodId = d?.shipping_method?.id !== undefined ? String(d.shipping_method.id) : null;
  const txStatus = d?.transaction_evidence?.status ?? null;
  const base = {
    method,
    ship_class: null as string | null,
    transaction_status: txStatus,
    shipping_confirmed: false,
  };

  if (!d) {
    return { ...base, cost: null, status: "failed", reason: "商品情報を読み取れませんでした" };
  }

  // 着払いは購入者が払うので、出品者の送料負担は0円。
  // ここを推定で210円などにすると原価が丸ごとズレるため、明示的に0円として返す。
  if (d.shipping_payer?.code === "buyer") {
    return {
      ...base,
      cost: 0,
      status: "fixed",
      shipping_confirmed: true,
      reason: "着払い(購入者負担)のため出品者の送料負担は0円",
    };
  }

  const cls = d.shipping_class;
  const fee = cls?.total_fee ?? cls?.fee ?? cls?.shipping_fee ?? null;

  // 発送時に確定した金額。id=0 は「まだ確定していない」空箱なので採用しない
  if (cls && typeof cls.id === "number" && cls.id > 0 && typeof fee === "number" && fee > 0) {
    return {
      ...base,
      cost: fee,
      ship_class: cls.name ?? null,
      status: "got",
      shipping_confirmed: true,
      reason: `発送時に確定した実送料(${cls.name ?? "区分不明"} ¥${fee})`,
    };
  }

  // 全国一律の配送方法は、発送前でも金額が確定している
  if (method) {
    for (const [re, yen] of FIXED_FEE_BY_METHOD) {
      if (re.test(method)) {
        return {
          ...base,
          cost: yen,
          status: "fixed",
          shipping_confirmed: true,
          reason: `${method}は全国一律 ¥${yen}`,
        };
      }
    }
  }

  // ここから先は金額が入っていなかったケース。理由を切り分ける
  const shipped = SHIPPED_TRANSACTION_STATUSES.has(txStatus ?? "");
  if (!shipped) {
    return {
      ...base,
      cost: null,
      status: "na",
      reason: txStatus
        ? "まだ発送されていないため実送料は確定していません"
        : "売れていない(取引が始まっていない)ため実送料はありません",
    };
  }

  // 配送方法IDが取れない経路(画面から読んだ場合)もあるので、名前でも判定する
  const carriedByMercari =
    (methodId !== null && MERCARI_SHIPPING_METHOD_IDS.has(methodId)) ||
    (method !== null && /メルカリ便|たのメル便/.test(method));
  if (carriedByMercari) {
    // メルカリ便で発送済みなら本来は取れるはず。取れないのは仕様変更か非公開
    return {
      ...base,
      cost: null,
      status: "failed",
      reason: `${method ?? "メルカリ便"}だが発送区分が公開されていませんでした`,
    };
  }
  return {
    ...base,
    cost: null,
    status: "na",
    reason: `${method ?? "配送方法不明"}は出品者が個別に支払うため金額が公開されません`,
  };
}
