"use client";
import { motion } from "framer-motion";

export default function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="hero">
      <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        {title}
      </motion.h1>
      <p>{subtitle}</p>
      <ul>
        <li>Fast</li>
        <li>Accessible</li>
        <li>Open source</li>
      </ul>
    </section>
  );
}
