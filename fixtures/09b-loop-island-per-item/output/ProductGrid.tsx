import { ProductGridArticle } from "./ProductGrid.client";

type Product = { id: string; name: string; price: number; blurb: string };

export default function ProductGrid({ heading, products }: { heading: string; products: Product[] }) {
  return (
    <section>
      <h2>{heading}</h2>
      <p>Hand-picked for you.</p>
      <div className="grid">
        {products.map((product) => (
          <ProductGridArticle key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}
