import TodoList from "@/components/TodoList";
import ProductGrid from "@/components/ProductGrid";
import ReviewList from "@/components/ReviewList";
import FaqItem from "@/components/FaqItem";
import Counter from "@/components/Counter";
import { products, reviews, todos } from "@/lib/data";

export default function Lists() {
  return (
    <main>
      <TodoList title="Todos" todos={todos} />
      <ProductGrid heading="Products" products={products} />
      <ReviewList title="Reviews" reviews={reviews} />
      <FaqItem faq={{ question: "Is this fast?", answer: "Yes, mostly server-rendered.", category: "Perf" }} />
      <Counter title="Counter" start={1} />
    </main>
  );
}
