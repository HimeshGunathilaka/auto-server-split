import { ArticleFooterButton } from "./ArticleFooter.client";

export default function ArticleFooter({ author, updated }: { author: string; updated: string }) {
  return (
    <footer>
      <p>Written by {author}</p>
      <p>Last updated {updated}</p>
      <nav>
        <a href="/blog">All posts</a>
      </nav>
      <ArticleFooterButton />
    </footer>
  );
}
