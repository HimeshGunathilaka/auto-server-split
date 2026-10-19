"use client";
import { useState } from "react";

type Comment = { id: string; author: string; text: string };

function Avatar({ name }: { name: string }) {
  return <span className="avatar">{name.slice(0, 1)}</span>;
}

function LikeButton({ initial }: { initial: number }) {
  const [n, setN] = useState(initial);
  return <button onClick={() => setN(n + 1)}>♥ {n}</button>;
}

export function CommentItem({ comment }: { comment: Comment }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li>
      <strong>{comment.author}</strong>
      <div>
        <Avatar name={comment.author} />
        <p className={expanded ? "full" : "clamped"}>{comment.text}</p>
        <button onClick={() => setExpanded(!expanded)}>{expanded ? "Less" : "More"}</button>
      </div>
      <LikeButton initial={0} />
    </li>
  );
}

export default function CommentThread({ title, comments }: { title: string; comments: Comment[] }) {
  return (
    <section>
      <h2>
        <Avatar name={title} /> {title}
      </h2>
      <ul>
        {comments.map((c) => (
          <CommentItem key={c.id} comment={c} />
        ))}
      </ul>
      <LikeButton initial={comments.length} />
    </section>
  );
}
