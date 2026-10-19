"use client";
import { useState } from "react";

type Post = { id: string; title: string; excerpt: string };

export function LikeCardButton({ post, count }: { post: Post; count: number }) {
  const [likes, setLikes] = useState(count);
  return (
    <button onClick={() => setLikes(likes + 1)} data-post={post.id}>
      {likes} likes
    </button>
  );
}
