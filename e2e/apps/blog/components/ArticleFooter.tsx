"use client";

export default function ArticleFooter({ author, updated }: { author: string; updated: string }) {
  return (
    <footer>
      <p>Written by {author}</p>
      <p>Last updated {updated}</p>
      <nav>
        <a href="/lists">All lists</a>
      </nav>
      <button
        onClick={() => {
          window.scrollTo({ top: 0 });
          document.body.dataset.scrolled = "yes";
        }}
      >
        Back to top
      </button>
    </footer>
  );
}
