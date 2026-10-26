"use client";

export default function Stamp({ at }: { at: string }) {
  return <time>{new Date(at).getHours()}</time>;
}
