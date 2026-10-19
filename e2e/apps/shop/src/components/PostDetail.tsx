"use client";
import { useState } from "react";
import type { PostDoc } from "@/lib/models";

export default function PostDetail({ post }: { post: PostDoc }) {
  const [likes, setLikes] = useState(post.likes);
  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.body}</p>
      <footer>
        <button data-id={post._id.toString()} onClick={() => setLikes(likes + 1)}>
          {likes} likes · {post.author.name} · {post.createdAt.getUTCFullYear()}
        </button>
      </footer>
    </article>
  );
}
