"use client";
import { useState, useTransition } from "react";
import { likePost } from "@/app/actions";

type Post = { id: string; title: string; summary: string };

export default function CommentBox({ post, onSubmit }: { post: Post; onSubmit: (postId: string, text: string) => Promise<string> }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [likes, setLikes] = useState(0);
  const [pending, startTransition] = useTransition();
  return (
    <section>
      <h2>{post.title}</h2>
      <p>{post.summary}</p>
      <button disabled={pending} onClick={() => startTransition(async () => setLikes(await likePost(post.id)))}>
        Like ({likes})
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(post.id, text).then(setStatus);
        }}
      >
        <textarea aria-label="comment" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Comment</button>
        <output>{status}</output>
      </form>
    </section>
  );
}
