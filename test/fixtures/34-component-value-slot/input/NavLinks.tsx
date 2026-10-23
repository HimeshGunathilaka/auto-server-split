"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, InvoiceIcon } from "./icons";

const links = [
  { name: "Home", href: "/dashboard", icon: HomeIcon },
  { name: "Invoices", href: "/dashboard/invoices", icon: InvoiceIcon },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <>
      {links.map((link) => {
        const LinkIcon = link.icon;
        return (
          <Link
            key={link.name}
            href={link.href}
            className={pathname === link.href ? "nav-link active" : "nav-link"}
          >
            <LinkIcon className="w-6" />
            <p className="label">{link.name}</p>
          </Link>
        );
      })}
    </>
  );
}
