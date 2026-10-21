"use client";
import { useDisclosure } from "./hooks/useDisclosure";

export function FaqItemDiv({ faq }: { faq: { answer: string } }) {
  const { open, toggle } = useDisclosure();
  return (
    <div className="answer">
      <button onClick={toggle} aria-expanded={open}>
        {open ? "Hide answer" : "Show answer"}
      </button>
      {open && <p>{faq.answer}</p>}
    </div>
  );
}
