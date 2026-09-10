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
      <head>
        {/* 本文の書体。読み込めない環境ではOS標準のゴシックにそのまま落ちる
            (globals.css の font-family に控えを並べてある) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
