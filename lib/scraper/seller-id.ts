/**
 * セラーIDの正規化だけを置く小さなファイル。
 *
 * 中身は seller-run.ts に置きたくなるが、あちらは Playwright を読み込むため、
 * ジョブを1行入れるだけの /api/jobs から呼ぶと実ブラウザ一式が
 * サーバーレスのバンドルに巻き込まれてしまう(それを避ける構成にしてある)。
 * 依存の無いこの関数だけを分けておく。
 */

/**
 * プロフィールURLを貼られても動くようにする。
 *
 *   https://jp.mercari.com/user/profile/223868190       → "223868190"
 *   https://jp.mercari.com/shops/profile/waKfjv...      → "shops:waKfjv..."
 *   223868190                                           → "223868190"
 *
 * 画面・API・CLIのどこから来た文字列でも同じ形に揃えたいので、入口ごとに書かずここを通す。
 */
export function normalizeSellerId(input: string): string {
  const s = String(input ?? "").trim();
  const shops = s.match(/\/shops\/profile\/([^/?#]+)/);
  if (shops) return `shops:${shops[1]}`;
  const user = s.match(/\/user\/profile\/([^/?#]+)/);
  if (user) return user[1];
  return s;
}
