"use client";
import { useState } from "react";
import type { IProduct } from "@/lib/models";
import { money } from "@/lib/money";

export default function ProductRow({ product }: { product: IProduct }) {
  const [copied, setCopied] = useState("");
  return (
    <tr>
      <td>{product.name}</td>
      <td>{money(product.price)}</td>
      <td>
        <button onClick={() => setCopied(`${product._id.toString()}/${product.categoryId}`)}>Copy id</button>
        <output>{copied}</output>
      </td>
    </tr>
  );
}
