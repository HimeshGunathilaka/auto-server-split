"use client";
import { useDisclosure } from "./hooks/useDisclosure";

type Faq = { question: string; answer: string; category: string };

export default function FaqItem({ faq }: { faq: Faq }) {
  const { open, toggle } = useDisclosure();
  return (
    <div className="faq">
      <span className="category">{faq.category}</span>
      <h3>{faq.question}</h3>
      <p className="lead">Frequently asked</p>
      <div className="answer">
        <button onClick={toggle} aria-expanded={open}>
          {open ? "Hide answer" : "Show answer"}
        </button>
        {open && <p>{faq.answer}</p>}
      </div>
    </div>
  );
}
