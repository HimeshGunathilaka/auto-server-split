"use client";
import { useState } from "react";
import type { Review, Sort } from "./types";

export function ReviewListDiv({ reviews }: { reviews: Review[] }) {
  const [sort, setSort] = useState<Sort>("newest");
  return (
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
  );
}
