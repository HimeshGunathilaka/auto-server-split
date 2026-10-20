"use client";
import { useState } from "react";

export function ClapperButton({ LABEL, initial }) {
  const [claps, setClaps] = useState(initial);
  return (
    <button onClick={() => setClaps(claps + 1)}>
      {LABEL}: {claps}
    </button>
  );
}
