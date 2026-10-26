"use client"; // auto-server-split-ignore: the chart library must stay out of the server bundle
import { format } from "date-fns";
import { useState } from "react";

export default function PostCard({ title, date }: { title: string; date: string }) {
  const [liked, setLiked] = useState(false);
  return (
    <article>
      <h2>{title}</h2>
      <time>{format(new Date(date), "PPP")}</time>
      <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>
    </article>
  );
}
