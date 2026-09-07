/**
 * セラーのプロフィール画像URLを決める。
 *
 * ■ なぜ「スクレイプして保存した値」だけに頼らないのか
 *   保存できるのは、そのセラーのプロフィールページを開いたときだけ。
 *   3-1のセラーリサーチは、集計して上位N人だけ名前を引く設計なので、
 *   それ以外のセラーには画像URLが入らない。DBを見に行っても空のままになる。
 *
 * ■ 通常セラーは、画像URLがセラーIDから一意に決まる
 *     https://static.mercdn.net/thumb/members/webp/<セラーID>.jpg
 *   実際に確認したところ(2026-09-04):
 *     - 画像を設定しているセラー → 200 / image/webp
 *     - 設定していないセラー     → 403
 *     - 参照元(Referer)の制限は無い。キャッシュ用のクエリ文字列も不要
 *   つまり **保存済みの値が無くても、IDさえ分かれば出せる**。
 *   403のときはブラウザ側の onError で頭文字表示に切り替える。
 *
 * ■ メルカリShopsの店舗ロゴはIDから導出できない
 *   資産IDが別採番のため、スクレイプして保存した値がある場合だけ出す。
 */

/** 通常セラーのプロフィール画像URL。導出できなければ null */
export function derivedMercariAvatarUrl(sellerExternalId: string | null | undefined): string | null {
  if (!sellerExternalId) return null;
  // メルカリShopsは "shops:<店舗ID>"。ロゴのURLはIDから決まらない
  if (sellerExternalId.startsWith("shops:")) return null;
  // 通常セラーのIDは数字のみ。想定外の形なら組み立てない
  if (!/^\d+$/.test(sellerExternalId)) return null;
  return `https://static.mercdn.net/thumb/members/webp/${sellerExternalId}.jpg`;
}

/**
 * 実際に表示に使うURLを決める。
 * 保存済みの値があればそれを優先し、無ければIDから組み立てる。
 */
export function avatarUrlFor(
  sellerExternalId: string | null | undefined,
  storedAvatarUrl?: string | null
): string | null {
  return storedAvatarUrl || derivedMercariAvatarUrl(sellerExternalId);
}
