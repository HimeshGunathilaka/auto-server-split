"use client";
import { useState } from "react";

export function StatButton() {
  const [shown, setShown] = useState(true);
  return <button onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>;
}
