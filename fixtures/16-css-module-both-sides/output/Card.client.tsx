"use client";
import { useState } from "react";
import styles from "./Card.module.css";

export function CardButton() {
  const [count, setCount] = useState(0);
  return (
    <button className={styles.button} onClick={() => setCount(count + 1)}>
      {count}
    </button>
  );
}
