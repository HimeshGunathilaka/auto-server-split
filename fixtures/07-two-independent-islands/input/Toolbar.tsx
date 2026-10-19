"use client";
import { useState } from "react";

export default function Toolbar({ title }: { title: string }) {
  const [bold, setBold] = useState(false);
  const [count, setCount] = useState(0);
  return (
    <div className="toolbar">
      <h1>{title}</h1>
      <p>Edit the document below.</p>
      <button onClick={() => setBold(!bold)} aria-pressed={bold}>
        Bold
      </button>
      <hr />
      <span>Static separator</span>
      <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
    </div>
  );
}
