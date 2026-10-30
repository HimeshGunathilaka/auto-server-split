"use client";
import { useState } from "react";

export function BadgeSpan() {
  const [on, setOn] = useState(false);
  return <span onClick={() => setOn(!on)}>{on ? "on" : "off"}</span>;
}
