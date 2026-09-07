"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconCalculator, IconLayers, IconShield, IconUsers } from "./icons";

const steps = [
  { href: "/", step: "1", label: "セラーリサーチ", Icon: IconUsers },
  { href: "/seller-deepdive", step: "2", label: "セラー深掘り", Icon: IconLayers },
  { href: "/deepdive-list", step: "3", label: "深掘りリスト", Icon: IconCalculator },
];

export default function Nav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {steps.map(({ href, step, label, Icon }) => (
        <Link key={href} href={href} className="nav-item" data-active={pathname === href}>
          <span className="nav-step">{step}</span>
          <Icon size={15} />
          {label}
        </Link>
      ))}

      {/* 会員管理は管理者だけに出す。出しても入れないが、無いものは押されない */}
      {isAdmin && (
        <>
          <div className="nav-sep" />
          <Link href="/admin" className="nav-item" data-active={pathname === "/admin"}>
            <span className="nav-step nav-step-admin">
              <IconShield size={11} />
            </span>
            <IconShield size={15} />
            会員管理
          </Link>
        </>
      )}
    </nav>
  );
}
