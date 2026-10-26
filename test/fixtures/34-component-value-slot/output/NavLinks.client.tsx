"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLinksLink({ link, children }: { link: { name: string; href: string }; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <Link
      href={link.href}
      className={pathname === link.href ? "nav-link active" : "nav-link"}
    >
      {children}
      <p className="label">{link.name}</p>
    </Link>
  );
}
