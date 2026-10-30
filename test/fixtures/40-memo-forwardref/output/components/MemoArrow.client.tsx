"use client";
import { useState } from "react";

export function MemoArrowButton() {
  const [open, setOpen] = useState(false);
  return <button onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>;
}
