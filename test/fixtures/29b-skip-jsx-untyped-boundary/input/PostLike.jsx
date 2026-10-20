"use client";
import { useState } from "react";

export default function PostLike({ post }) {
  const [liked, setLiked] = useState(false);
  return (
    <div>
      <h2>{post.title}</h2>
      <p>{post.summary}</p>
      <button onClick={() => setLiked(!liked)} data-id={post.id}>
        {liked ? "♥" : "♡"}
      </button>
    </div>
  );
}
