import { HeroMotionH1 } from "./Hero.client";

export default function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="hero">
      <HeroMotionH1 title={title} />
      <p>{subtitle}</p>
      <ul>
        <li>Fast</li>
        <li>Accessible</li>
        <li>Open source</li>
      </ul>
    </section>
  );
}
