"use client";
import { useState, useTransition } from "react";
import { likePost } from "./actions";

type Post = { id: string; title: string; summary: string };

export default function CommentBox({ post, onSubmit }: { post: Post; onSubmit: (postId: string, text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <section>
      <h2>{post.title}</h2>
      <p>{post.summary}</p>
      <button disabled={pending} onClick={() => startTransition(() => likePost(post.id))}>
        Like
      </button>
      <form onSubmit={(e) => { e.preventDefault(); void onSubmit(post.id, text); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Comment</button>
      </form>
    </section>
  );
}
