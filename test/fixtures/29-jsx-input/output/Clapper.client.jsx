"use client";
import { useState } from "react";

const LABEL = "Claps";

export function ClapperButton({ initial }) {
  const [claps, setClaps] = useState(initial);
  return (
    <button onClick={() => setClaps(claps + 1)}>
      {LABEL}: {claps}
    </button>
  );
}
