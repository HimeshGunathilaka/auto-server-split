"use client";
import PostCard from "./PostCard";

export default function Sidebar() {
  return (
    <aside>
      <PostCard post={{ title: "Pinned", date: "2026-01-01", body: "Pinned post" }} />
    </aside>
  );
}
