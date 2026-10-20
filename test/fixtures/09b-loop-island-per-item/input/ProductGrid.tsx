"use client";

type Product = { id: string; name: string; price: number; blurb: string };

export default function ProductGrid({ heading, products }: { heading: string; products: Product[] }) {
  return (
    <section>
      <h2>{heading}</h2>
      <p>Hand-picked for you.</p>
      <div className="grid">
        {products.map((product) => (
          <article key={product.id}>
            <h3>{product.name}</h3>
            <p>{product.blurb}</p>
            <button onClick={() => alert(`Added ${product.name}`)}>Add · ${product.price}</button>
          </article>
        ))}
      </div>
    </section>
  );
}
