import type { ReactNode } from "react";
import "./globals.css";
import SiteHeader from "@/components/SiteHeader";
import ThemeShell from "@/components/ThemeShell";
import Footer from "@/components/Footer";

export const metadata = { title: "E2E blog" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ThemeShell>
          <SiteHeader siteName="E2E blog" />
          {children}
          <Footer />
        </ThemeShell>
      </body>
    </html>
  );
}
