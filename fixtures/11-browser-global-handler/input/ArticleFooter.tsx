"use client";

export default function ArticleFooter({ author, updated }: { author: string; updated: string }) {
  return (
    <footer>
      <p>Written by {author}</p>
      <p>Last updated {updated}</p>
      <nav>
        <a href="/blog">All posts</a>
      </nav>
      <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Back to top</button>
    </footer>
  );
}
