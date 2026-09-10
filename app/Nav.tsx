"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconCalculator, IconCart, IconLayers, IconShield, IconUsers } from "./icons";

/**
 * サイドバーのメニュー。
 *
 * 1行に「番号・アイコン・画面名・ひとこと説明」を並べる。
 * 説明を添えているのは、①②③がそれぞれ何をする画面なのかを
 * 覚えていなくても選べるようにするため。
 */
const steps = [
  { href: "/", step: "1", label: "セラーリサーチ", desc: "売れてるセラーを探す", Icon: IconUsers },
  { href: "/seller-deepdive", step: "2", label: "セラー深掘り", desc: "鉄板商品を抽出", Icon: IconLayers },
  { href: "/deepdive-list", step: "3", label: "深掘りリスト", desc: "原価で黒字判定", Icon: IconCalculator },
];

/**
 * まだ無い機能。押せない見た目で置いておく。
 * 作らないと決めたら、この配列を空にすれば見出しごと消える。
 */
const soon: { label: string; Icon?: typeof IconCart }[] = [
  { label: "仕入リスト", Icon: IconCart },
  { label: "販売管理" },
  { label: "フリマ販売履歴" },
];

/** 狭い画面では引き出しになっているので、選んだら閉じる */
function closeNav() {
  document.body.classList.remove("nav-open");
}

export default function Nav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  return (
    <>
      <div className="nav-group">リサーチ</div>
      <nav className="nav">
        {steps.map(({ href, step, label, desc, Icon }) => (
          <Link
            key={href}
            href={href}
            className="nav-item"
            data-active={pathname === href}
            onClick={closeNav}
          >
            <span className="nav-step">{step}</span>
            <span className="nav-icon">
              <Icon size={15} />
            </span>
            <span className="nav-txt">
              <b>{label}</b>
              <i>{desc}</i>
            </span>
          </Link>
        ))}
      </nav>

      <Link href="/guide" className="side-guide" data-active={pathname === "/guide"} onClick={closeNav}>
        📖 使い方ガイド
      </Link>

      {soon.length > 0 && (
        <>
          <div className="nav-group">仕入れ・販売</div>
          <div className="side-soon">
            {soon.map(({ label, Icon }) => (
              <span key={label}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {Icon && <Icon size={14} />}
                  {label}
                </span>
                <span className="soon">準備中</span>
              </span>
            ))}
          </div>
        </>
      )}

      {/* 会員管理は管理者だけに出す。出しても入れないが、無いものは押されない */}
      {isAdmin && (
        <>
          <div className="nav-group">管理</div>
          <nav className="nav">
            <Link href="/admin" className="nav-item" data-active={pathname === "/admin"} onClick={closeNav}>
              <span className="nav-step">管</span>
              <span className="nav-icon">
                <IconShield size={15} />
              </span>
              <span className="nav-txt">
                <b>会員管理</b>
                <i>ログインIDを発行する</i>
              </span>
            </Link>
          </nav>
        </>
      )}
    </>
  );
}
