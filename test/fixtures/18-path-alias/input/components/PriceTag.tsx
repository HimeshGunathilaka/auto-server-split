"use client";
import { useState } from "react";
import { formatPrice } from "@/lib/format";

export default function PriceTag({ name, cents }: { name: string; cents: number }) {
  const [qty, setQty] = useState(1);
  return (
    <div>
      <h4>{name}</h4>
      <p>{formatPrice(cents)} each</p>
      <button onClick={() => setQty(qty + 1)}>
        {qty} × {formatPrice(cents)}
      </button>
    </div>
  );
}
