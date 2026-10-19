"use client";
import { useState } from "react";
import styles from "./Cart.module.css";
import { money } from "@/lib/money";

type Line = { sku: string; name: string; cents: number };

function QuantityStepper({ initial }: { initial: number }) {
  const [qty, setQty] = useState(initial);
  return (
    <span>
      <button onClick={() => setQty(Math.max(0, qty - 1))}>−</button>
      <b>{qty}</b>
      <button onClick={() => setQty(qty + 1)}>+</button>
    </span>
  );
}

function CartLine({ line }: { line: Line }) {
  return (
    <li className={styles.line}>
      <span>{line.name}</span> <span>{money(line.cents)}</span> <QuantityStepper initial={1} />
    </li>
  );
}

export default function Cart({ lines }: { lines: Line[] }) {
  const [coupon, setCoupon] = useState("");
  return (
    <section className={styles.cart}>
      <h2>Cart</h2>
      <ul>
        {lines.map((line) => (
          <CartLine key={line.sku} line={line} />
        ))}
      </ul>
      <div>
        <input aria-label="coupon" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
        <p>{coupon ? `Coupon ${coupon} applied` : "No coupon"}</p>
      </div>
    </section>
  );
}
