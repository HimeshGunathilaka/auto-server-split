"use client";
import { useState } from "react";
import type { Review, Sort } from "@/lib/types";

export default function ReviewList({ reviews, title }: { reviews: Review[]; title: string }) {
  const [sort, setSort] = useState<Sort>("newest");
  return (
    <section>
      <h2>{title}</h2>
      <p>{reviews.length} reviews</p>
      <div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="newest">Newest</option>
          <option value="best">Best</option>
        </select>
        <ol>
          {[...reviews]
            .sort((a, b) => (sort === "best" ? b.stars - a.stars : 0))
            .map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
        </ol>
      </div>
    </section>
  );
}
