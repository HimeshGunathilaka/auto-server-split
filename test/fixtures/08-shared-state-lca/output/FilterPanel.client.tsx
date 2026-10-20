"use client";
import { useState } from "react";

export function FilterPanelDiv() {
  const [query, setQuery] = useState("");
  return (
    <div className="filters">
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" />
      <p className="hint">Showing results for “{query || "everything"}”</p>
    </div>
  );
}
