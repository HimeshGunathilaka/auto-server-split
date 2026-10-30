"use client";
import { useEffect } from "react";

// An effect that no element uses: it moves to an island that renders nothing.
export default function SectionTracker({ section }: { section: string }) {
  useEffect(() => {
    document.body.dataset.section = section;
    return () => {
      delete document.body.dataset.section;
    };
  }, [section]);
  return (
    <header>
      <h2>Section: {section}</h2>
      <p>Tracked on the page body.</p>
    </header>
  );
}
