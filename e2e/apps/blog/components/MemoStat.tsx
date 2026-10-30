"use client";
import { memo, useState } from "react";

// memo() is unwrapped: the component only renders on the server after the split.
function MemoStat({ label, value }: { label: string; value: number }) {
  const [open, setOpen] = useState(false);
  return (
    <dl>
      <dt>{label}</dt>
      <dd>{value.toLocaleString("en-US")}</dd>
      <button onClick={() => setOpen(!open)}>{open ? "Hide details" : "Show details"}</button>
    </dl>
  );
}

export default memo(MemoStat);
