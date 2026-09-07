import "./globals.css";

/**
 * 一番外側のレイアウト。html/body だけを用意する。
 *
 * サイドバー付きの画面枠は app/(app)/layout.tsx にある。
 * こちらを薄くしておくことで、ログイン画面(app/login)は枠なしで出せる。
 */
export const metadata = {
  title: "転売リサーチダッシュボード",
  description: "メルカリで繰り返し売れている鉄板商品を見つけ、仕入れ利益を試算する",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
