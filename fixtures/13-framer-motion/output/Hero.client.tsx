"use client";
import { motion } from "framer-motion";

export function HeroMotionH1({ title }: { title: string }) {
  return (
    <motion.h1 initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      {title}
    </motion.h1>
  );
}
