"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconCalculator, IconLayers, IconUsers } from "./icons";

const items = [
  { href: "/", step: "1", label: "セラーリサーチ", Icon: IconUsers },
  { href: "/seller-deepdive", step: "2", label: "セラー深掘り", Icon: IconLayers },
  { href: "/deepdive-list", step: "3", label: "深掘りリスト", Icon: IconCalculator },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {items.map(({ href, step, label, Icon }) => (
        <Link key={href} href={href} className="nav-item" data-active={pathname === href}>
          <span className="nav-step">{step}</span>
          <Icon size={15} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
