"use client";
import { useState } from "react";
import PostCard from "./PostCard";

export default function Shelf() {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <PostCard post={{ title: "Pinned", date: "2026-01-01", body: "Pinned post" }} />
      <button onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} more</button>
    </section>
  );
}
