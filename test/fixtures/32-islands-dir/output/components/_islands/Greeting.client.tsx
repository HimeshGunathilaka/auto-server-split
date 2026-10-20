"use client";
import { useState } from "react";
import { shout } from "../format";
import type { Person } from "../Greeting";

export function GreetingButton({ person }: { person: Person }) {
  const [loud, setLoud] = useState(false);
  return <button onClick={() => setLoud(!loud)}>{loud ? shout(person.name) : person.name}</button>;
}
