"use client";
import { format } from "date-fns";
import { marked } from "marked";
import { useState } from "react";

type Post = { title: string; date: string; body: string };

export default function PostCard({ post }: { post: Post }) {
  const [liked, setLiked] = useState(false);
  return (
    <article>
      <h2>{post.title}</h2>
      <time>{format(new Date(post.date), "PPP")}</time>
      <div dangerouslySetInnerHTML={{ __html: marked(post.body) as string }} />
      <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>
    </article>
  );
}
