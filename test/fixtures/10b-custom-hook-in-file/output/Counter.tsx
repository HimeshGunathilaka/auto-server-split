import { CounterButton } from "./Counter.client";

const STEP = 2;

export default function Counter({ title, start }: { title: string; start: number }) {
  const heading = title.toUpperCase();
  return (
    <div>
      <h2>{heading}</h2>
      <p>Step size {STEP}</p>
      <CounterButton start={start} />
    </div>
  );
}
