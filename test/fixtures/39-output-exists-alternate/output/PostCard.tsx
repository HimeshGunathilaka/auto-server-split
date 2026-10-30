import { format } from "date-fns";
import { marked } from "marked";
import { PostCardButton } from "./PostCard.island.client";

type Post = { title: string; date: string; body: string };

export default function PostCard({ post }: { post: Post }) {
  return (
    <article>
      <h2>{post.title}</h2>
      <time>{format(new Date(post.date), "PPP")}</time>
      <div dangerouslySetInnerHTML={{ __html: marked(post.body) as string }} />
      <PostCardButton />
    </article>
  );
}
