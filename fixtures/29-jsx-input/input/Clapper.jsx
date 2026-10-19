"use client";
import { useState } from "react";

const LABEL = "Claps";

export default function Clapper({ title, initial = 0 }) {
  const [claps, setClaps] = useState(initial);
  return (
    <div>
      <h2>{title}</h2>
      <p>Enjoyed it?</p>
      <button onClick={() => setClaps(claps + 1)}>
        {LABEL}: {claps}
      </button>
    </div>
  );
}
