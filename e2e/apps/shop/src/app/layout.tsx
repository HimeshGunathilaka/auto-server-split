import type { ReactNode } from "react";

export const metadata = { title: "E2E shop" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <a href="/">Shop</a> · <a href="/post">Journal</a>
        </header>
        {children}
      </body>
    </html>
  );
}
