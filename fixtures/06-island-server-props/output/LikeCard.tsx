import { LikeCardButton } from "./LikeCard.client";

type Post = { id: string; title: string; excerpt: string };

export default function LikeCard({ post, count }: { post: Post; count: number }) {
  return (
    <article>
      <h2>{post.title}</h2>
      <p>{post.excerpt}</p>
      <footer>
        <span>Post {post.id}</span>
        <LikeCardButton post={post} count={count} />
      </footer>
    </article>
  );
}
