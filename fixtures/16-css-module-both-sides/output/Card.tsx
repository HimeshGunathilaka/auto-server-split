import styles from "./Card.module.css";
import { CardButton } from "./Card.client";

export default function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      <p>{body}</p>
      <CardButton />
    </div>
  );
}
