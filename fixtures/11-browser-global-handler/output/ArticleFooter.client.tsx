"use client";

export function ArticleFooterButton() {
  return <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Back to top</button>;
}
