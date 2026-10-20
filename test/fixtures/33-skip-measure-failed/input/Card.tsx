"use client";
import { useState } from "react";
import { fmt } from "virtual-fmt";

export default function Card({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2>{fmt(title)}</h2>
      <p>Some static text</p>
      <p>More static text</p>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
