"use client";

import { usePathname } from "next/navigation";

/**
 * 画面の上に固定される帯。
 *
 * 左に「いまどの画面にいるか」、右に「いまどれだけ溜まっているか」を出す。
 * 一覧を下までスクロールしても現在地と件数が見えるので、
 * 画面を行き来しなくても次にやることを決められる。
 *
 * 件数はサーバー側(app/(app)/layout.tsx)で数えて渡す。
 * ここでは表示だけを担当する。
 */
export type Counts = {
  /** リサーチした回数(searches の行数) */
  searches: number;
  /** 深掘りリストに入っている商品数 */
  deepdive: number;
  /** 実行待ち・実行中のジョブ数 */
  running: number;
} | null;

/** URL から画面名を決める。サイドバーの表記と揃える */
const TITLES: [test: (p: string) => boolean, title: string][] = [
  [(p) => p === "/", "セラーリサーチ"],
  [(p) => p.startsWith("/seller-deepdive"), "セラー深掘り"],
  [(p) => p.startsWith("/deepdive-list"), "深掘りリスト"],
  [(p) => p.startsWith("/admin"), "会員管理"],
  [(p) => p.startsWith("/guide"), "使い方ガイド"],
];

function screenTitle(pathname: string): string {
  return TITLES.find(([test]) => test(pathname))?.[1] ?? "転売リサーチ";
}

/** サイドバーの引き出しを開け閉めする(狭い画面のときだけ出るボタン) */
function toggleNav() {
  document.body.classList.toggle("nav-open");
}

export default function AppHeader({ counts }: { counts: Counts }) {
  const pathname = usePathname();

  return (
    <>
      <header className="app-header">
        <button type="button" className="nav-toggle" onClick={toggleNav} aria-label="メニューを開く">
          ☰
        </button>
        <div className="screen-title">{screenTitle(pathname)}</div>
        <div className="hspace" />
        {counts && (
          <div className="quota">
            <div className="q">
              <span>リサーチ</span>
              <b>{counts.searches.toLocaleString()}</b>
            </div>
            <div className="q">
              <span>深掘り</span>
              <b>{counts.deepdive.toLocaleString()}</b>
            </div>
            <div className="q" data-busy={counts.running > 0}>
              <span>実行中</span>
              <b>{counts.running.toLocaleString()}</b>
            </div>
          </div>
        )}
      </header>

      {/* 引き出しを開けている間、外側を押したら閉じる(狭い画面のときだけ見える) */}
      <button type="button" className="nav-overlay" onClick={toggleNav} aria-label="メニューを閉じる" />
    </>
  );
}
