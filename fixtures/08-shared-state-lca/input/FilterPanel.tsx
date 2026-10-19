"use client";
import { useState } from "react";

type Props = { heading: string; intro: string; options: string[] };

export default function FilterPanel({ heading, intro, options }: Props) {
  const [query, setQuery] = useState("");
  return (
    <section>
      <header>
        <h2>{heading}</h2>
        <p>{intro}</p>
      </header>
      <div className="filters">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" />
        <p className="hint">Showing results for “{query || "everything"}”</p>
      </div>
      <ul>
        {options.map((option) => (
          <li key={option}>{option}</li>
        ))}
      </ul>
    </section>
  );
}
