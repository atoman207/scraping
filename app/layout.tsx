import "./globals.css";
import Nav from "./Nav";
import { IconTrend } from "./icons";

export const metadata = {
  title: "転売リサーチダッシュボード",
  description: "メルカリで繰り返し売れている鉄板商品を見つけ、仕入れ利益を試算する",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-mark">
                <IconTrend size={16} />
              </span>
              転売リサーチ
            </div>
            <Nav />
            <div className="sidebar-foot">
              メルカリ → 鉄板商品 → 仕入れ利益
              <br />
              の3ステップで調べます。
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
