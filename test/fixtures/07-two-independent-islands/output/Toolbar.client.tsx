"use client";
import { useState } from "react";

export function ToolbarButton() {
  const [bold, setBold] = useState(false);
  return (
    <button onClick={() => setBold(!bold)} aria-pressed={bold}>
      Bold
    </button>
  );
}

export function ToolbarButton2() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>;
}
