"use client";
import { useState } from "react";

export default function Mostly({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <h3>{title}</h3>
      <div>
        <button onClick={() => setN(n + 1)}>+</button>
        <button onClick={() => setN(n - 1)}>-</button>
        <output>{n}</output>
      </div>
    </div>
  );
}
