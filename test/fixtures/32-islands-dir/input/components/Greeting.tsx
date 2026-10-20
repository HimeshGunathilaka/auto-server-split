"use client";
import { useState } from "react";
import { shout } from "./format";

export type Person = { name: string; city: string };

export default function Greeting({ person }: { person: Person }) {
  const [loud, setLoud] = useState(false);
  return (
    <section>
      <h2>Hello</h2>
      <p>From {person.city}</p>
      <button onClick={() => setLoud(!loud)}>{loud ? shout(person.name) : person.name}</button>
    </section>
  );
}
