/**
 * セラーリサーチのキーワード / あるあるワードの区切り方。
 *
 * 原本(Seller Scope)と同様、キーワードは複数入れられる。
 * 区切りはカンマ・読点・空白。重複は除き、最大件数で切る。
 * 各語は別クエリとして検索し、結果をまとめる(OR)。
 * → 関連語を並べると、優秀セラーがより出やすくなる。
 */

/** searches.keywords のスキーマどおり。最大10件 */
export const MAX_SEARCH_KEYWORDS = 10;

/** あるあるワードも同じ区切り。件数は緩めに */
export const MAX_ARUARU_WORDS = 20;

/**
 * 文字列または配列を、検索用の語リストに分解する。
 * 空・重複は除く。max を超えた分は捨てる。
 */
export function parseSearchWords(
  input: string | string[] | unknown,
  opts: { max?: number } = {}
): string[] {
  const max = opts.max ?? MAX_SEARCH_KEYWORDS;
  const raw: string[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      raw.push(...String(item ?? "").split(/[,、\s]+/));
    }
  } else if (input != null && String(input).trim() !== "") {
    raw.push(...String(input).split(/[,、\s]+/));
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 実際にメルカリへ投げるクエリ一覧を作る。
 * - あるあるなし: 各キーワードをそのまま
 * - あるあるあり: キーワード × あるある の組み合わせ(それぞれ AND、組み合わせ同士は OR)
 */
export function buildSearchQueries(keywords: string[], aruaruWords: string[] = []): string[] {
  if (!keywords.length) return [];
  if (!aruaruWords.length) return [...keywords];
  return keywords.flatMap((kw) => aruaruWords.map((w) => `${kw} ${w}`.trim()));
}

/** 画面・ログ用の表示文言 */
export function formatKeywordsLabel(keywords: string[]): string {
  return keywords.join("、");
}
