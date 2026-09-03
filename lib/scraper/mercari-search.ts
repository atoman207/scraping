/**
 * 発注仕様書 3-1: セラーリサーチ
 *
 * メルカリの検索結果ページを普通に開き、**ページ自身が描画のために受け取った
 * 検索レスポンス(JSON)** を読んで1出品ずつのデータに直す。
 *
 * なぜこの方法か:
 *   検索結果の一覧DOMには出品者が出ない。DOMだけを見る実装では、出品者を知るために
 *   商品ページを1件ずつ開く必要があり、1ページ110件×10ページ=1,100件に対して
 *   1,100回のアクセスが必要になる。現実的でないため、従来は上位30件だけ出品者を
 *   解決していた(＝仕様「取得した各商品について出品者が分かる」を満たせていない)。
 *
 *   一方、ページを描画するためにブラウザが受け取っているレスポンスには、
 *   各商品の出品者ID・出品日時・商品状態・配送方法IDが最初から含まれている。
 *   これを読めば、**追加のアクセスを一切増やさずに全件の出品者が分かる**。
 *
 *   こちらから内部APIを直接叩くのではなく、あくまで「ページを開いた結果として
 *   ブラウザが受け取ったもの」を読む。アクセス回数はページを開く回数のみ。
 *
 * 取れないもの:
 *   - 出品者名: 検索レスポンスには入っていない(IDのみ)。集計後に必要な分だけ
 *     プロフィールページから取得する(mercari.ts の resolveSellerNames)。
 *   - 売却日時: 公開されていない。updated(最終更新)が売却時刻に近いが別物なので、
 *     sold_at には入れず updated_at として別に持つ。
 */

/** 検索レスポンスの1商品(必要な項目のみ。実際にはもっと多くの項目が入っている) */
export type MercariApiItem = {
  id: string;
  sellerId: string;
  buyerId: string;
  status: string; // ITEM_STATUS_ON_SALE | ITEM_STATUS_SOLD_OUT | ITEM_STATUS_TRADING
  name: string;
  price: string; // 文字列で来る
  created: string; // UNIX秒(文字列)
  updated: string; // UNIX秒(文字列)
  thumbnails?: string[];
  photos?: { uri: string }[];
  itemType: string; // ITEM_TYPE_MERCARI | ITEM_TYPE_BEYOND(メルカリShops)
  itemConditionId?: string; // "1" = 新品、未使用
  shippingMethodId?: string;
  shippingPayerId?: string;
  categoryId?: string;
  shopName?: string;
  shop?: { id: string } | null;
};

export type MercariSearchResponse = {
  meta?: { nextPageToken?: string; previousPageToken?: string; numFound?: string };
  items?: MercariApiItem[];
};

/** 商品状態マスタ: id=1 が「新品、未使用」 */
export const CONDITION_NEW = "1";

/**
 * 配送方法マスタ(services/master/v2/datasets/shipping_methods)の id → 名前。
 * ページを開いたときに一緒に降ってくるので、実行時に上書きできるようにしてある。
 * ここに持っているのは、マスタが取れなかったときのフォールバック。
 */
export const SHIPPING_METHOD_FALLBACK: Record<string, string> = {
  "0": "未定",
  "1": "未定",
  "4": "ゆうパック",
  "6": "ゆうメール",
};

/** メルカリShopsの商品か(通常の m+数字 以外はShops扱い) */
export function isShopsItemId(id: string): boolean {
  return !/^m\d+$/.test(id);
}

export function itemUrlOf(id: string): string {
  return isShopsItemId(id)
    ? `https://jp.mercari.com/shops/product/${id}`
    : `https://jp.mercari.com/item/${id}`;
}

/**
 * セラーIDを組み立てる。メルカリShopsは通常ユーザーと名前空間が違うので
 * "shops:" を付けて区別する(既存の profileUrl() がこの規約を前提にしている)。
 */
export function sellerIdOf(it: MercariApiItem): string | null {
  if (it.itemType === "ITEM_TYPE_BEYOND" || it.shop?.id) {
    const sid = it.shop?.id;
    return sid ? `shops:${sid}` : null;
  }
  return it.sellerId || null;
}

/** UNIX秒(文字列) → ISO日時文字列。取れなければ null */
export function unixToIso(v: string | undefined): string | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * 「売れた」とみなすか。
 *
 * メルカリの検索で status=sold_out を指定すると、実際には
 * SOLD_OUT(取引完了) と TRADING(購入済み・取引中) の両方が返る。
 * 画面上どちらも「売り切れ」と表示され、**購入されたという事実は同じ**なので、
 * リサーチ上はどちらも「売れた」として数える(メルカリの画面表示と一致させる)。
 */
export function isSoldStatus(status: string): boolean {
  return status === "ITEM_STATUS_SOLD_OUT" || status === "ITEM_STATUS_TRADING";
}

/** 検索レスポンスから取り出した、1出品ぶんの生データ */
export type SearchItem = {
  external_id: string;
  seller_external_id: string;
  title: string;
  price: number;
  sold: boolean;
  status_raw: string;
  /** 出品日時(ISO) */
  listed_at: string | null;
  /** 最終更新日時(ISO)。売却時刻そのものではないが、回転日数の推定に使う */
  updated_at: string | null;
  /** 新品かどうか。マスタid=1(新品、未使用)のみ true。不明なら null */
  is_new: boolean | null;
  shipping_method_id: string | null;
  shipping_method: string | null;
  category_id: string | null;
  image_url: string | null;
  listing_url: string;
  is_shops: boolean;
};

/**
 * 検索レスポンス1ページぶんを SearchItem[] に直す。
 * 壊れた行は黙って捨てず、呼び出し側が件数差で気づけるよう単純にスキップする。
 */
export function parseSearchResponse(
  res: MercariSearchResponse,
  shippingMethods: Record<string, string> = {}
): { items: SearchItem[]; nextPageToken: string | null; numFound: number | null; skipped: number } {
  const out: SearchItem[] = [];
  let skipped = 0;
  for (const it of res.items ?? []) {
    const sid = sellerIdOf(it);
    const price = Number(it.price);
    if (!it.id || !sid || !Number.isFinite(price)) {
      skipped++;
      continue;
    }
    const smId = it.shippingMethodId ?? null;
    out.push({
      external_id: it.id,
      seller_external_id: sid,
      title: it.name ?? "",
      price,
      sold: isSoldStatus(it.status),
      status_raw: it.status,
      listed_at: unixToIso(it.created),
      updated_at: unixToIso(it.updated),
      is_new: it.itemConditionId ? it.itemConditionId === CONDITION_NEW : null,
      shipping_method_id: smId,
      shipping_method: smId ? (shippingMethods[smId] ?? SHIPPING_METHOD_FALLBACK[smId] ?? null) : null,
      category_id: it.categoryId ?? null,
      image_url: it.thumbnails?.[0] ?? it.photos?.[0]?.uri ?? null,
      listing_url: itemUrlOf(it.id),
      is_shops: it.itemType === "ITEM_TYPE_BEYOND" || Boolean(it.shop?.id),
    });
  }
  const next = res.meta?.nextPageToken || null;
  const numFound = res.meta?.numFound ? Number(res.meta.numFound) : null;
  return { items: out, nextPageToken: next, numFound: Number.isFinite(numFound!) ? numFound : null, skipped };
}

/** 配送方法マスタのレスポンスを id→名前 の表に直す */
export function parseShippingMethods(res: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const arr = (res as { shippingMethods?: { id: string; name: string; isDeprecated?: string }[] })?.shippingMethods;
  if (!Array.isArray(arr)) return out;
  for (const m of arr) {
    // 同じ名前で複数idがある(送料負担者違い)。あとから来たもので上書きして問題ない
    if (m?.id && m?.name) out[m.id] = m.name;
  }
  return out;
}

/**
 * 検索URLを組み立てる。
 *
 * sort=created_time&order=desc で「新しい順」。付けないと「おすすめ順」になり、
 * 仕様書の「新しい順に取得」を満たさないため必須。
 */
export function buildSearchUrl(query: string, pageToken: string | null): string {
  const p = new URLSearchParams();
  p.set("keyword", query);
  p.set("status", "sold_out");
  p.set("sort", "created_time");
  p.set("order", "desc");
  // 商品状態では絞り込まない。
  // 検索の段階で「新品、未使用」に限定すると、集計した新品率が必ず100%になり
  // 指標として意味を持たなくなるため。中古を除きたい場合は、取得後の集計側で
  // 中古を売上件数から外す(新品率の分母には残す)。
  if (pageToken) p.set("page_token", pageToken);
  return `https://jp.mercari.com/search?${p.toString()}`;
}

/** ページ番号(0始まり) → メルカリのページトークン */
export function pageTokenOf(page: number): string | null {
  return page <= 0 ? null : `v1:${page}`;
}
