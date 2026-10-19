"use client";
import { useState } from "react";

const CTA = "Subscribe";

export default function Newsletter({ heading, perks = 3 }) {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  return (
    <aside>
      <h3>{heading}</h3>
      <p>{perks} perks for subscribers</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDone(true);
        }}
      >
        <input aria-label="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit">{done ? `Thanks, ${email}` : CTA}</button>
      </form>
    </aside>
  );
}
