"use client";
import { formatTitle, markShared } from "@/lib/share";

export default function ShareCard({ id, title }: { id: string; title: string }) {
  return (
    <section>
      <h3>{formatTitle(title)}</h3>
      <p>Share this card with a friend.</p>
      <button onClick={() => markShared(id)}>Share</button>
    </section>
  );
}
