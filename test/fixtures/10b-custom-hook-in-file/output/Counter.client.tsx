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

export function CounterButton({ start }: { start: number }) {
  const { n, inc } = useCounter(start);
  const handleClick = () => inc();
  return <button onClick={handleClick}>{label(n)}</button>;
}
