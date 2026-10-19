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
        <Link href="/lists" className={pathname === "/lists" ? "active" : undefined}>
          Lists
        </Link>{" "}
        <Link href="/misc">Misc</Link>{" "}
        <button onClick={() => router.push("/about")}>About</button>
      </nav>
    </header>
  );
}
