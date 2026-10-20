"use client";
import { useState } from "react";

export default function Badge({ label }: { label: string }) {
  const [seen, setSeen] = useState(false);
  return (
    <span>
      <em>{label}</em>
      <small>static</small>
      <button onClick={() => setSeen(true)}>{seen ? "seen" : "new"}</button>
    </span>
  );
}
