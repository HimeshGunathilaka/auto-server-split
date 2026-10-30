"use client";
import { forwardRef, useState } from "react";

type FieldProps = { label: string; hint: string };

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint }, _ref) {
  const [value, setValue] = useState("");
  return (
    <label>
      <span>{label}</span>
      <small>{hint}</small>
      <input value={value} onChange={(e) => setValue(e.target.value)} />
    </label>
  );
});
