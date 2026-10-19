"use client";
import { useState } from "react";

type User = { name: string; bio: string } | null;

export default function Profile({ user }: { user: User }) {
  if (!user) return <p>Not signed in</p>;
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2>{user.name}</h2>
      <p>{user.bio}</p>
      <button onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} details</button>
    </section>
  );
}
