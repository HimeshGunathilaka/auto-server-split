"use client";
import { forwardRef, useState } from "react";

const FancyInput = forwardRef<HTMLInputElement, { label: string }>(function FancyInput({ label }, ref) {
  const [value, setValue] = useState("");
  return (
    <label>
      <span>{label}</span>
      <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
    </label>
  );
});

export default FancyInput;
