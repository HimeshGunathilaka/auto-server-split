"use client";
import { useState, type ReactNode } from "react";

export function AccordionDiv({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="accordion-item">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Collapse" : "Expand"} article
      </button>
      <div className="accordion-panel" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
