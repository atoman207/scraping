/**
 * 発注仕様書 3-1 の集計部分: 検索で集めた出品を、セラー単位の指標にまとめる。
 *
 * 従来の lib/engine/rank.ts は「DBに入れてから読み直して集計する」作りで、
 *   - 回転日数: sold_at が常に null のため計算できない
 *   - 新品率  : 商品状態を持っていないため null 固定のプレースホルダ
 * という状態だった。
 *
 * ここでは検索した結果をメモリ上でそのまま集計する。
 *   - 回転日数 = 最終更新日時 − 出品日時（売却日時は公開されていないための推定）
 *   - 新品率   = 商品状態が「新品、未使用」の割合
 * DBに書く前に集計するので、上位N人に絞ってから名前を引く運用ができる
 * （数百人ぶんの名前を全部引くと時間がかかりすぎるため）。
 */

/** 集計の入力。searchSold() の戻り値をそのまま渡せる形にしてある */
export type AggregateInput = {
  seller_external_id: string;
  price: number;
  listed_at?: string | null;
  updated_at?: string | null;
  is_new?: boolean | null;
  category_id?: string | null;
  matched_keyword?: string;
};

export type SellerStats = {
  seller_external_id: string;
  /** そのキーワードで売れていた件数 */
  total_sold: number;
  avg_price: number;
  /** 平均回転日数(出品→最終更新の推定)。1件も算出できなければ null */
  turnover_days: number | null;
  /** 新品率(%)。商品状態が取れた出品が1件も無ければ null */
  new_item_rate: number | null;
  /** 扱っているカテゴリ数 */
  genre_count: number;
  /** ヒットしたキーワード(複数ある場合は「、」区切り) */
  matched_keywords: string[];
  /** セラーの分類 */
  seller_type: SellerType;
};

export type SellerType = "専門特化(穴場候補)" | "中堅特化" | "複数展開" | "小規模/単発";

/**
 * 回転日数(1件ぶん)。出品日時と最終更新日時の差。
 * どちらか欠けている・逆転している場合は null。
 */
export function turnoverOf(listedAt: string | null | undefined, updatedAt: string | null | undefined): number | null {
  if (!listedAt || !updatedAt) return null;
  const a = Date.parse(listedAt);
  const b = Date.parse(updatedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const days = (b - a) / 86400000;
  if (days < 0) return null;
  return days;
}

/**
 * セラーの分類。参考にした既存サービスと同じ4分類を、根拠のある基準で再現している。
 *
 *   専門特化(穴場候補): 1ジャンルに絞っていて、よく売れている
 *                       → 同じ商材を繰り返し仕入れている＝真似しやすい
 *   中堅特化          : 1ジャンルだが件数はほどほど
 *   複数展開          : 複数ジャンルに手を広げている（真似しにくい）
 *   小規模/単発       : 件数が少なく、継続的に売っているとは言えない
 *
 * しきい値は、この画面の使い方（＝繰り返し売れているセラーを見つける）に合わせた
 * 実用値。運用しながら調整できるよう定数にまとめてある。
 */
export const TYPE_THRESHOLDS = {
  /** これ未満は「小規模/単発」 */
  minSold: 3,
  /** 「専門特化(穴場候補)」に必要な販売件数 */
  hotSold: 10,
  /** 「専門特化」とみなすジャンル数の上限 */
  focusedGenres: 2,
};

export function classifySeller(totalSold: number, genreCount: number): SellerType {
  if (totalSold < TYPE_THRESHOLDS.minSold) return "小規模/単発";
  if (genreCount > TYPE_THRESHOLDS.focusedGenres) return "複数展開";
  if (totalSold >= TYPE_THRESHOLDS.hotSold) return "専門特化(穴場候補)";
  return "中堅特化";
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 中央値。外れ値(1件だけ極端に高い/安い)に引っ張られにくい */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 出品の配列をセラー単位にまとめる。売れた件数の多い順で返す。
 *
 * 回転日数は中央値を使う。平均だと「半年売れ残っていた1件」に引きずられて
 * 実態より悪く見えるため。
 */
export function aggregateBySeller(
  items: AggregateInput[],
  opts: {
    /**
     * 中古も売上件数に含めるか。既定 false(中国輸入向け)。
     *
     * false のとき、中古の出品は total_sold・平均価格・回転日数から外すが、
     * **新品率の分母には残す**。そうしないと新品率が必ず100%になり、
     * 「中古メインのセラーかどうか」を判定できなくなるため。
     */
    includeUsed?: boolean;
  } = {}
): SellerStats[] {
  const includeUsed = opts.includeUsed ?? false;
  const bySeller = new Map<string, AggregateInput[]>();
  for (const it of items) {
    const arr = bySeller.get(it.seller_external_id) ?? [];
    arr.push(it);
    bySeller.set(it.seller_external_id, arr);
  }

  const out: SellerStats[] = [];
  for (const [sid, all] of bySeller) {
    // 新品率は「そのセラーが何を売っているか」を見る指標なので、全件で計算する
    const known = all.filter((r) => r.is_new === true || r.is_new === false);
    // 件数・価格・回転は、対象にする商品だけで計算する
    const rows = includeUsed ? all : all.filter((r) => r.is_new !== false);
    if (!rows.length) continue;

    const prices = rows.map((r) => r.price).filter((p) => Number.isFinite(p));
    const turns = rows
      .map((r) => turnoverOf(r.listed_at, r.updated_at))
      .filter((v): v is number => v !== null);
    const genres = new Set(rows.map((r) => r.category_id).filter(Boolean) as string[]);
    const keywords = [...new Set(rows.map((r) => r.matched_keyword).filter(Boolean) as string[])];

    const totalSold = rows.length;
    const genreCount = genres.size;
    out.push({
      seller_external_id: sid,
      total_sold: totalSold,
      avg_price: Math.round(mean(prices) ?? 0),
      turnover_days: turns.length ? Math.round((median(turns) ?? 0) * 10) / 10 : null,
      new_item_rate: known.length ? Math.round((known.filter((r) => r.is_new).length / known.length) * 100) : null,
      genre_count: genreCount,
      matched_keywords: keywords,
      seller_type: classifySeller(totalSold, genreCount),
    });
  }

  return out.sort((a, b) => b.total_sold - a.total_sold || b.avg_price - a.avg_price);
}

/**
 * NG判定。参考にした既存サービスと同じ考え方。
 *   新品率が基準未満  → 中古メインのセラー。中国輸入の参考にならない
 *   回転日数が基準超  → 売れるのが遅い。真似しても在庫を抱える
 */
export function judgeSeller(
  s: Pick<SellerStats, "new_item_rate" | "turnover_days" | "seller_type">,
  ngNewPct: number,
  ngRotationDays: number
): { lowNew: boolean; slow: boolean; ng: boolean; hot: boolean } {
  const lowNew = s.new_item_rate !== null && s.new_item_rate < ngNewPct;
  const slow = s.turnover_days !== null && s.turnover_days > ngRotationDays;
  return { lowNew, slow, ng: lowNew || slow, hot: s.seller_type.includes("穴場") };
}
