"use client";
import { useState, useTransition } from "react";
import { likePost } from "./actions";

export function CommentBoxButton({ post }: { post: { id: string } }) {
  const [pending, startTransition] = useTransition();
  return (
    <button disabled={pending} onClick={() => startTransition(() => likePost(post.id))}>
      Like
    </button>
  );
}

export function CommentBoxForm({ post, onSubmit }: { post: { id: string }; onSubmit: (postId: string, text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); void onSubmit(post.id, text); }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit">Comment</button>
    </form>
  );
}
