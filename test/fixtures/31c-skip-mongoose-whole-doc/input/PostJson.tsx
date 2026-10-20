"use client";
import { useState } from "react";
import type { PostDoc } from "./types/models";

export default function PostJson({ post }: { post: PostDoc }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2>{post.title}</h2>
      <div>
        <button onClick={() => setOpen(!open)}>Toggle</button>
        {open && <pre>{JSON.stringify(post)}</pre>}
      </div>
    </section>
  );
}
