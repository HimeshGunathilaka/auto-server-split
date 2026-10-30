"use client";
import { marked } from "marked";
import { memo, useState } from "react";

export const MemoArrow = memo(({ title, body }: { title: string; body: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2>{title}</h2>
      <div dangerouslySetInnerHTML={{ __html: marked(body) as string }} />
      <button onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>
    </section>
  );
});
