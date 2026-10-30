"use client";
import { forwardRef, useState } from "react";

type FieldProps = { label: string; hint: string };

// forwardRef() whose function ignores the ref: unwrapped, with the props type moved onto the parameter.
const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint }, _ref) {
  const [value, setValue] = useState("");
  return (
    <label className="field">
      <span>{label}</span>
      <small>{hint}</small>
      <input aria-label="name" value={value} onChange={(e) => setValue(e.target.value)} />
    </label>
  );
});

export default Field;
