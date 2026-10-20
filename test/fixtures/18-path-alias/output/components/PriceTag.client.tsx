"use client";
import { useState } from "react";
import { formatPrice } from "@/lib/format";

export function PriceTagButton({ cents }: { cents: number }) {
  const [qty, setQty] = useState(1);
  return (
    <button onClick={() => setQty(qty + 1)}>
      {qty} × {formatPrice(cents)}
    </button>
  );
}
