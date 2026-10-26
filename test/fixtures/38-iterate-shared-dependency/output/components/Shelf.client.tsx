"use client";
import { useState } from "react";

export function ShelfButton() {
  const [open, setOpen] = useState(true);
  return <button onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} more</button>;
}
