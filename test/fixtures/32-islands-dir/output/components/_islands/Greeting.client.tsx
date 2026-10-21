"use client";
import { useState } from "react";
import { shout } from "../format";

export function GreetingButton({ person }: { person: { name: string } }) {
  const [loud, setLoud] = useState(false);
  return <button onClick={() => setLoud(!loud)}>{loud ? shout(person.name) : person.name}</button>;
}
