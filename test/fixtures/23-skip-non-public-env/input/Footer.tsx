"use client";
import { useState } from "react";

export default function Footer() {
  const [open, setOpen] = useState(false);
  return (
    <footer>
      <p>Build {process.env.BUILD_ID}</p>
      <p>Support: {process.env.NEXT_PUBLIC_SUPPORT_EMAIL}</p>
      <button onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>
    </footer>
  );
}
