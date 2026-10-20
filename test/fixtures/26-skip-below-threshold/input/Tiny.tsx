"use client";
import { useState } from "react";

export default function Tiny({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <h1>{title}</h1>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </div>
  );
}
