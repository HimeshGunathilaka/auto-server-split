"use client";

type Product = { id: string; name: string; price: number; blurb: string };

export function ProductGridArticle({ product }: { product: Product }) {
  return (
    <article>
      <h3>{product.name}</h3>
      <p>{product.blurb}</p>
      <button onClick={() => alert(`Added ${product.name}`)}>Add · ${product.price}</button>
    </article>
  );
}
