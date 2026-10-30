"use client";
import { memo, useState } from "react";

function Stat({ label, value }: { label: string; value: number }) {
  const [shown, setShown] = useState(true);
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <button onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
    </div>
  );
}

export default memo(Stat);
