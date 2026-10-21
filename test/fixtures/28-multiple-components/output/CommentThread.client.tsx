"use client";
import { useState } from "react";

function Avatar({ name }: { name: string }) {
  return <span className="avatar">{name.slice(0, 1)}</span>;
}

export function LikeButton({ initial }: { initial: number }) {
  const [n, setN] = useState(initial);
  return <button onClick={() => setN(n + 1)}>♥ {n}</button>;
}

export function CommentItemDiv({ comment }: { comment: { author: string; text: string } }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <Avatar name={comment.author} />
      <p className={expanded ? "full" : "clamped"}>{comment.text}</p>
      <button onClick={() => setExpanded(!expanded)}>{expanded ? "Less" : "More"}</button>
    </div>
  );
}
