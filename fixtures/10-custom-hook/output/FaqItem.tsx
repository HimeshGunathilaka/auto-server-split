import { FaqItemDiv } from "./FaqItem.client";

type Faq = { question: string; answer: string; category: string };

export default function FaqItem({ faq }: { faq: Faq }) {
  return (
    <div className="faq">
      <span className="category">{faq.category}</span>
      <h3>{faq.question}</h3>
      <p className="lead">Frequently asked</p>
      <FaqItemDiv faq={faq} />
    </div>
  );
}
