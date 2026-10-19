"use client";
import { useState } from "react";
import styles from "./Card.module.css";

export default function Card({ title, body }: { title: string; body: string }) {
  const [count, setCount] = useState(0);
  return (
    <div className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <p>{body}</p>
      <button className={styles.button} onClick={() => setCount(count + 1)}>
        Card clicks: {count}
      </button>
    </div>
  );
}
