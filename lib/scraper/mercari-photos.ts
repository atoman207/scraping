/**
 * メルカリの商品写真のURLを組み立てる。
 *
 * このファイルは**依存を一切持たない**。画面やAPIからも読むので、
 * ここに Playwright を引き込むと、ブラウザを起動できない環境
 * (Vercel などのサーバーレス)でAPIごと動かなくなるため。
 * スクレイパー側からは lib/scraper/sourcing.ts が再輸出している。
 */

/**
 * メルカリのサムネイルURLを、可能なら元画像のURLに読み替える。
 *
 * DBに入っているのは一覧用のサムネイル(webp・数KB)で、画像検索に使うには小さい。
 * メルカリは同じ商品IDで元画像(jpg)も公開しているので、そちらを先に試す。
 */
export function toOriginalMercariImage(url: string): string | null {
  const m = url.match(/static\.mercdn\.net\/thumb\/item\/(?:webp|jpeg|jpg)\/(m\d+)_(\d+)\.jpg/);
  if (!m) return null;
  return `https://static.mercdn.net/item/detail/orig/photos/${m[1]}_${m[2]}.jpg`;
}

/**
 * 同じ出品の写真を、1枚目から順に最大 count 枚ぶん組み立てる。
 *
 * メルカリの1枚目は「文字入れ」「箱・パッケージ」「複数点を並べた写真」のことが多く、
 * 画像検索にはいちばん不向きなことがある。2枚目以降は商品そのものを写した
 * 素直な写真であることが多いので、そちらでも探して結果を合わせる。
 *
 * 写真の少ない出品では存在しない番号が403を返すが、取得側が失敗した枚を飛ばすので、
 * ここでは枚数を確かめない(確かめるとその分アクセスが増える)。
 */
export function mercariPhotoUrls(url: string, count = 5): string[] {
  const m = url.match(/(m\d+)_(\d+)\.jpg/);
  if (!m) return [url];

  const itemId = m[1];
  const given = Number(m[2]);
  const n = Math.max(1, count);

  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    // 渡された枚だけは URL をそのまま使う。
    // downloadProductImage() が「元画像 → だめならサムネイル」の順に試すので、
    // 元画像が消えている出品でも取りこぼさない。
    // それ以外の枚は元画像しか当てが無いので、直接その URL を作る。
    out.push(i === given ? url : `https://static.mercdn.net/item/detail/orig/photos/${itemId}_${i}.jpg`);
  }
  return out;
}
