import Link from "next/link";
import { SiteHeaderLink, SiteHeaderButton } from "./SiteHeader.client";

export default function SiteHeader({ siteName }: { siteName: string }) {
  return (
    <header>
      <Link href="/">{siteName}</Link>
      <p className="tagline">Notes on building for the web</p>
      <nav>
        <SiteHeaderLink />
        <SiteHeaderButton />
      </nav>
    </header>
  );
}
