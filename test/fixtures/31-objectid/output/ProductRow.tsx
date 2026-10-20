import type { Types } from "mongoose";
import { ProductRowButton } from "./ProductRow.client";

type Product = { _id: Types.ObjectId; name: string; price: number; categoryId: Types.ObjectId | null };

export default function ProductRow({ product }: { product: Product }) {
  return (
    <tr>
      <td>{product.name}</td>
      <td>{product.price}</td>
      <td>
        <ProductRowButton product={{ _id: String(product._id), categoryId: product.categoryId == null ? product.categoryId : String(product.categoryId) }} />
      </td>
    </tr>
  );
}
