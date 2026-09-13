/**
 * scraper/base.py の ScrapedListing と scraper/adapters_template.py の
 * インターフェース定義をTypeScriptに移植したもの。
 *
 * 発注仕様書 3-1 / 3-2 / 3-3 に対応する型はすべてここに集約している。
 */

/** listings テーブルへ投入する1出品分のデータ(= Python版 ScrapedListing dataclass) */
export type ScrapedListing = {
  platform: string;
  external_id: string;
  seller_external_id: string;
  seller_name: string;
  title: string;
  price: number;
  status: "active" | "sold";
  listed_at?: string | null;
  sold_at?: string | null;
  shipping_method?: string | null;
  shipping_cost?: number | null;
  image_url?: string | null;
  listing_url?: string | null;
};

/** セラーのプロフィール情報(sellers テーブル用) */
export type ScrapedSeller = {
  platform: string;
  seller_external_id: string;
  seller_name: string;
  rating: number | null;
  review_count: number | null;
  profile_url: string | null;
  /** プロフィール画像のURL。設定していないセラーはメルカリ既定の画像になる */
  avatar_url?: string | null;
};

/**
 * 発注仕様書 3-1: セラーリサーチ
 * キーワードのSOLD商品を検索し、出品(≒売却実績)を集める。
 */
export interface SellerResearchAdapter {
  readonly platformName: string;
  /**
   * キーワード(+あるあるワードでの絞り込み)でSOLD商品を検索し、新しい順に
   * maxPages 分読み込む。戻り値の各要素はどのセラーの出品かが分かる
   * (seller_external_id, seller_name を含む)。
   * キーワードは複数可(文字列または配列)。複数時はそれぞれ検索して結果をまとめる。
   */
  searchSold(keyword: string | string[], aruaruWords: string[], maxPages?: number): Promise<ScrapedListing[]>;
}

/**
 * 発注仕様書 3-2: セラー深掘り
 * 指定セラーの出品を取得し、実送料も可能な範囲で取る。
 */
export interface SellerDeepdiveAdapter {
  readonly platformName: string;
  /** 指定セラーの出品(売却済み中心)を新しい順に maxItems 件取得する */
  getSellerListings(sellerExternalId: string, maxItems?: number): Promise<ScrapedListing[]>;
  /** セラーのプロフィール(名前・評価数など)を取得する */
  getSellerProfile(sellerExternalId: string): Promise<ScrapedSeller | null>;
  /**
   * 取引完了済みの商品ページから実送料を取得する。
   * 普通郵便・定形外・発送方法未定・取引未完了などは取得できないため null を返す。
   * 呼び出し側は上位N件(標準=3件/詳細=20件など)にだけ呼ぶことでコストを抑える。
   */
  getRealShippingCost(listingUrl: string): Promise<number | null>;
}

/**
 * 発注仕様書 3-3: AliExpress / 1688 連携
 * 鉄板商品のタイトル・画像から、仕入れ候補を検索して提示する。
 */

/** 仕入れ候補を探す先 */
export type SourcingPlatform = "aliexpress" | "1688";

/**
 * どうやって見つけた候補か。
 *   title … 商品タイトルから作った検索語で探した
 *   image … 商品画像をアップロードして類似画像から探した
 *   link  … 検索そのものはできないので、人が開くための検索URLを組み立てただけ
 */
export type SourcingMode = "title" | "image" | "link";

export type SourcingCandidate = {
  source_platform: SourcingPlatform;
  search_mode: SourcingMode;
  /** 実際に投げた検索語、または画像検索の結果URL(あとから同じ検索を開き直せるように) */
  query: string | null;
  /** サイト側の商品ID(AliExpressの数字ID)。重複判定に使う */
  external_id: string | null;
  title: string;
  /** 表示通貨のままの価格 */
  price: number | null;
  currency: "JPY" | "USD" | "CNY" | null;
  /** 円換算(AliExpressは日本向け表示が円なので、たいていそのまま) */
  price_jpy: number | null;
  /** 仕入単価(元)換算。深掘りリストの unit_cost_cny にそのまま入れられる */
  price_cny: number | null;
  url: string;
  image_url: string | null;
  min_order_qty: number | null;
  /** 「1,000+ 点販売」の数字。売れている度合いの目安 */
  orders_count: number | null;
  rating: number | null;
  /** 広告枠の商品か(検索順位ではなく出稿で上に出ているもの) */
  is_ad: boolean;
  /**
   * 元の商品タイトルとの一致度 0-100。
   *
   * **タイトル検索のためだけの指標**。画像検索は「名前は違うが見た目が同じ」商品を
   * 拾うのが値打ちなので、この値が低いことは候補が悪いことを意味しない。
   * そのため画像検索の結果では画面に出さず、並べ替えにも使わない。
   */
  match_score: number | null;
  /**
   * 1688 の「回头率(リピート率 %)」。店の信用度でいちばん効く指標。
   * AliExpress には無いので null のままになる。
   */
  repeat_rate?: number | null;
  /** 店のバッジ(実力商家・厳選工場 など)。日本語に直したもの */
  badges?: string[] | null;
  /** 何枚の写真から見つかったか。複数枚から出た商品ほど確からしい */
  photo_hits?: number | null;
  /** 出品された日。長く売られている商品ほど定番である目安になる */
  listed_at?: string | null;
  /**
   * 検索サイトが返してきた順番(1が先頭)。
   *
   * 画像検索はサイト側が**見た目の近い順**に並べて返すので、その順番そのものが
   * いちばん確かな手がかりになる。こちらで文字列の一致度で並べ替えてしまうと
   * その情報が失われるため、順番を持ち歩いて画像検索の並びに使う。
   */
  source_rank: number | null;
};

export interface SourcingAdapter {
  readonly platformName: string;
  /** 商品タイトルから仕入れ候補を検索する */
  searchCandidates(title: string, limit?: number): Promise<SourcingCandidate[]>;
  /**
   * 商品画像から類似商品を検索する。
   * 画像に対応していないプラットフォームは実装しない(呼び出し側で分岐する)。
   *
   * 画像は**複数枚**受け取る。メルカリの1枚目は文字入れや箱の写真のことが多く、
   * それ1枚だけで探すと当たらないため、2枚目以降でも探して結果を合わせる。
   */
  searchByImage?(imageUrls: string[], limit?: number, sourceTitle?: string): Promise<SourcingCandidate[]>;
}

/** サイト側にブロックされた(bot判定・レート制限)ことを表すエラー */
export class BlockedError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "BlockedError";
  }
}

/**
 * 3-3 の「探し方」を、外から来た値(APIのリクエストなど)から安全に読む。
 * 指定が無ければタイトル検索と画像検索の両方。知らない値は黙って落とす。
 */
export function parseSourcingModes(input: unknown): ("title" | "image")[] {
  if (!Array.isArray(input)) return ["title", "image"];
  const out = input
    .map((m) => String(m))
    .filter((m): m is "title" | "image" => m === "title" || m === "image");
  return [...new Set(out)];
}
