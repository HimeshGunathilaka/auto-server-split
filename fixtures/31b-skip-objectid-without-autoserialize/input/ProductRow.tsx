"use client";
import type { Types } from "mongoose";

type Product = { _id: Types.ObjectId; name: string; price: number; categoryId: Types.ObjectId | null };

export default function ProductRow({ product }: { product: Product }) {
  return (
    <tr>
      <td>{product.name}</td>
      <td>{product.price}</td>
      <td>
        <button onClick={() => navigator.clipboard.writeText(`${product._id.toString()}/${product.categoryId}`)}>Copy id</button>
      </td>
    </tr>
  );
}
