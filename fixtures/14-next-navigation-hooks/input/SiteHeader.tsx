"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export default function SiteHeader({ siteName }: { siteName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <header>
      <Link href="/">{siteName}</Link>
      <p className="tagline">Notes on building for the web</p>
      <nav>
        <Link href="/blog" className={pathname === "/blog" ? "active" : undefined}>
          Blog
        </Link>
        <button onClick={() => router.back()}>Back</button>
      </nav>
    </header>
  );
}
