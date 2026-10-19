"use client";
import { useState, useTransition } from "react";
import { likePost } from "./actions";

type Post = { id: string; title: string; summary: string };

export function CommentBoxButton({ post }: { post: Post }) {
  const [pending, startTransition] = useTransition();
  return (
    <button disabled={pending} onClick={() => startTransition(() => likePost(post.id))}>
      Like
    </button>
  );
}

export function CommentBoxForm({ post, onSubmit }: { post: Post; onSubmit: (postId: string, text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); void onSubmit(post.id, text); }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit">Comment</button>
    </form>
  );
}
