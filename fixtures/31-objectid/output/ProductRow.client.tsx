"use client";

export function ProductRowButton({ product }: { product: { _id: string; categoryId: string | null } }) {
  return <button onClick={() => navigator.clipboard.writeText(`${product._id.toString()}/${product.categoryId}`)}>Copy id</button>;
}
