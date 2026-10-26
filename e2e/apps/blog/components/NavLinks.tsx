"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { HomeIcon, ListIcon } from "./icons";

// next-learn's nav-links.tsx shape: the icon component is read from data and rendered by a variable.
const links = [
  { name: "Home", href: "/", icon: HomeIcon },
  { name: "Lists", href: "/lists", icon: ListIcon },
  { name: "About", href: "/about", icon: HomeIcon },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav>
      {links.map((link) => {
        const LinkIcon = link.icon;
        return (
          <Link
            key={link.name}
            href={link.href}
            className={pathname === link.href ? "nav-link active" : "nav-link"}
          >
            <LinkIcon className="icon" />
            <span>{link.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}
