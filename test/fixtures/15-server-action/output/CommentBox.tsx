import { CommentBoxButton, CommentBoxForm } from "./CommentBox.client";

type Post = { id: string; title: string; summary: string };

export default function CommentBox({ post, onSubmit }: { post: Post; onSubmit: (postId: string, text: string) => Promise<void> }) {
  return (
    <section>
      <h2>{post.title}</h2>
      <p>{post.summary}</p>
      <CommentBoxButton post={{ id: post.id }} />
      <CommentBoxForm post={{ id: post.id }} onSubmit={onSubmit} />
    </section>
  );
}
