"use client";
import { useState } from "react";

type Post = { id: string; title: string; excerpt: string };

export default function LikeCard({ post, count }: { post: Post; count: number }) {
  const [likes, setLikes] = useState(count);
  return (
    <article>
      <h3>{post.title}</h3>
      <p>{post.excerpt}</p>
      <footer>
        <span>Post {post.id}</span>
        <button onClick={() => setLikes(likes + 1)} data-post={post.id}>
          {likes} likes
        </button>
      </footer>
    </article>
  );
}
