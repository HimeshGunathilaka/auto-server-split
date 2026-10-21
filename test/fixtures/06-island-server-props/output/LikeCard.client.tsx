"use client";
import { useState } from "react";

export function LikeCardButton({ post, count }: { post: { id: string }; count: number }) {
  const [likes, setLikes] = useState(count);
  return (
    <button onClick={() => setLikes(likes + 1)} data-post={post.id}>
      {likes} likes
    </button>
  );
}
