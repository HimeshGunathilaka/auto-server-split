"use client";
import { useState } from "react";

const STEP = 2;

// Local hook: moves with the island.
function useCounter(start: number) {
  const [n, setN] = useState(start);
  return { n, inc: () => setN((v) => v + STEP) };
}

function label(n: number): string {
  return n === 1 ? "1 click" : `${n} clicks`;
}

export default function Counter({ title, start }: { title: string; start: number }) {
  const { n, inc } = useCounter(start);
  const heading = title.toUpperCase();
  const handleClick = () => inc();
  return (
    <div>
      <h2>{heading}</h2>
      <p>Step size {STEP}</p>
      <button onClick={handleClick}>{label(n)}</button>
    </div>
  );
}
