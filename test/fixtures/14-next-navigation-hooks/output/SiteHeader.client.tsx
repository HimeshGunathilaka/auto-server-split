"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export function SiteHeaderLink() {
  const pathname = usePathname();
  return (
    <Link href="/blog" className={pathname === "/blog" ? "active" : undefined}>
      Blog
    </Link>
  );
}

export function SiteHeaderButton() {
  const router = useRouter();
  return <button onClick={() => router.back()}>Back</button>;
}
