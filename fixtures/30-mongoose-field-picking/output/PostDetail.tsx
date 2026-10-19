import type { PostDoc } from "./types/models";
import { PostDetailButton } from "./PostDetail.client";

export default function PostDetail({ post }: { post: PostDoc }) {
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
      <footer>
        <PostDetailButton post={{ _id: String(post._id), author: { name: post.author.name }, createdAt: post.createdAt, likes: post.likes }} />
      </footer>
    </article>
  );
}
