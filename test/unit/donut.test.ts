import { describe, expect, it } from "vitest";
import { splitOne } from "../helpers.js";

const island = (f: { outputs: Record<string, string> }) => f.outputs["Comp.client.tsx"] ?? "";
const server = (f: { outputs: Record<string, string> }) => f.outputs["Comp.tsx"] ?? "";

describe("donut slots", () => {
  it("uses slot1, slot2 when there are several static subtrees", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ a, b }: { a: string; b: string }) {
  const [tab, setTab] = useState(0);
  return (
    <main>
      <h1>Tabs</h1>
      <div className="tabs">
        <button onClick={() => setTab(0)}>A</button>
        <button onClick={() => setTab(1)}>B</button>
        <section hidden={tab !== 0}>
          <div>
            <h2>{a}</h2>
            <p>First</p>
          </div>
        </section>
        <section hidden={tab !== 1}>
          <div>
            <h2>{b}</h2>
            <p>Second</p>
          </div>
        </section>
      </div>
    </main>
  );
}
`);
    expect(f.status).toBe("split");
    expect(f.islands[0]?.props).toEqual(["slot1", "slot2"]);
    expect(island(f)).toContain("{slot1}");
    expect(island(f)).toContain("{slot2}");
    expect(island(f)).toContain("{ slot1, slot2 }: { slot1: ReactNode; slot2: ReactNode }");
    expect(server(f)).toContain("slot1={<div>");
    // the slot reads `a`, which therefore stays on the server and isn't an island prop
    expect(island(f)).not.toContain("{a}");
  });

  it("leaves trivial static subtrees inside the island", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1>Counter</h1>
      <div>
        <span>Count:</span>
        <output>{n}</output>
        <button onClick={() => setN(n + 1)}>+1</button>
      </div>
    </main>
  );
}
`);
    expect(f.islands[0]?.props).toEqual([]);
    expect(island(f)).toContain("<span>Count:</span>");
  });

  it("extracts a single element that calls an imported function", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
import { format } from "date-fns";
export default function Comp({ date }: { date: string }) {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1>Counter</h1>
      <div>
        <time>{format(new Date(date), "PPP")}</time>
        <output>{n}</output>
        <button onClick={() => setN(n + 1)}>+1</button>
      </div>
    </main>
  );
}
`);
    expect(f.islands[0]?.props).toEqual(["children"]);
    expect(island(f)).not.toContain("date-fns");
  });

  it("doesn't extract subtrees rendered under a client-only condition", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>Title</h1>
      <div>
        <button onClick={() => setOpen(!open)}>toggle</button>
        {open && (
          <article>
            <h2>Details</h2>
            <p>{body}</p>
          </article>
        )}
      </div>
    </main>
  );
}
`);
    expect(f.islands[0]?.props).toEqual(["body"]);
    expect(island(f)).toContain("<h2>Details</h2>");
  });

  it("names the slot slot1 when the island already takes a children prop", async () => {
    const f = await splitOne(`"use client";
import { useState, type ReactNode } from "react";
export default function Comp({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>Title</h1>
      <div>
        <button onClick={() => setOpen(!open)}>{open ? children : "closed"}</button>
        <p>{open ? "open" : "closed"}</p>
        <aside>
          <h2>Static</h2>
          <p>Sidebar</p>
        </aside>
      </div>
    </main>
  );
}
`);
    expect(f.islands[0]?.props).toEqual(["children", "slot1"]);
    expect(island(f)).toContain("{ children, slot1 }: { children: ReactNode; slot1: ReactNode }");
  });
});
