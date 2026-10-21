"use client";

export function ProductGridArticle({ product }: { product: { name: string; price: number; blurb: string } }) {
  return (
    <article>
      <h3>{product.name}</h3>
      <p>{product.blurb}</p>
      <button onClick={() => alert(`Added ${product.name}`)}>Add · ${product.price}</button>
    </article>
  );
}
