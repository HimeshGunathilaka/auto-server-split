"use client";
import { useState } from "react";

export function PostDetailButton({ post }: { post: { _id: string; author: { name: string }; createdAt: Date; likes: number } }) {
  const [likes, setLikes] = useState(post.likes);
  return (
    <button data-id={post._id.toString()} onClick={() => setLikes(likes + 1)}>
      {likes} likes · {post.author.name} · {post.createdAt.getFullYear()}
    </button>
  );
}
