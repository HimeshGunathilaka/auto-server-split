import { describe, expect, it } from "vitest";
import { splitOne } from "../helpers.js";

const island = (f: { outputs: Record<string, string> }) => f.outputs["Comp.client.tsx"] ?? "";
const server = (f: { outputs: Record<string, string> }) => f.outputs["Comp.tsx"] ?? "";

describe("taint propagation", () => {
  it("moves values derived from state with the island", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ title }: { title: string }) {
  const [n, setN] = useState(0);
  const doubled = n * 2;
  const label = \`\${doubled} items\`;
  return (
    <div>
      <h1>{title}</h1>
      <button onClick={() => setN(n + 1)}>{label}</button>
    </div>
  );
}
`);
    expect(f.status).toBe("split");
    expect(island(f)).toContain("const doubled = n * 2;");
    expect(island(f)).toContain("const label = `${doubled} items`;");
    expect(server(f)).not.toContain("doubled");
  });

  it("keeps server-only derived values on the server and passes them as props", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ price }: { price: number }) {
  const total = price * 1.2;
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p>{total}</p>
      <button onClick={() => setOpen(!open)}>{open ? total : "?"}</button>
    </div>
  );
}
`);
    expect(f.islands).toEqual([expect.objectContaining({ name: "CompButton", props: ["total"] })]);
    expect(server(f)).toContain("const total = price * 1.2;");
    expect(server(f)).toContain("<CompButton total={total} />");
  });

  it("treats a handler that calls a state setter as client-only", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  function handle() { setN(n + 1); }
  return (
    <section>
      <h2>Static</h2>
      <button onClick={handle}>{n}</button>
    </section>
  );
}
`);
    expect(island(f)).toContain("function handle() { setN(n + 1); }");
    expect(server(f)).not.toContain("handle");
  });

  it("copies a pure helper into the island when it's also used on the server", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ cents }: { cents: number }) {
  const fmt = (c: number) => (c / 100).toFixed(2);
  const [n, setN] = useState(1);
  return (
    <div>
      <p>{fmt(cents)}</p>
      <button onClick={() => setN(n + 1)}>{fmt(cents * n)}</button>
    </div>
  );
}
`);
    expect(f.status).toBe("split");
    expect(island(f)).toContain("const fmt = (c: number) => (c / 100).toFixed(2);");
    expect(server(f)).toContain("const fmt = (c: number) => (c / 100).toFixed(2);");
    expect(f.islands[0]?.props).toEqual(["cents"]);
  });

  it("treats render nondeterminism as client-only", async () => {
    const f = await splitOne(`"use client";
export default function Comp({ name }: { name: string }) {
  return (
    <div>
      <h1>{name}</h1>
      <p>Rendered at {Date.now()}</p>
    </div>
  );
}
`);
    expect(f.islands).toEqual([expect.objectContaining({ rootTag: "p" })]);
  });
});

describe("grouping (union-find + LCA)", () => {
  it("merges anchors that share a handler", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  const inc = () => setN(n + 1);
  return (
    <div>
      <h1>Title</h1>
      <div className="row">
        <button onClick={inc}>+</button>
        <span>static</span>
        <button onClick={inc}>also +</button>
      </div>
    </div>
  );
}
`);
    expect(f.islands.map((i) => i.rootTag)).toEqual(["div"]);
    expect(f.islands[0]?.name).toBe("CompDiv");
  });

  it("keeps anchors with separate state in separate islands", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  return (
    <div>
      <h1>Title</h1>
      <button onClick={() => setA(a + 1)}>{a}</button>
      <button onClick={() => setB(b + 1)}>{b}</button>
    </div>
  );
}
`);
    expect(f.islands.map((i) => i.name)).toEqual(["CompButton", "CompButton2"]);
  });

  it("merges a nested island into its ancestor", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  return (
    <div>
      <h1>Title</h1>
      <div className={open ? "open" : ""}>
        <button onClick={() => setOpen(!open)}>toggle</button>
        <button onClick={() => setN(n + 1)}>{n}</button>
      </div>
    </div>
  );
}
`);
    expect(f.islands.map((i) => i.rootTag)).toEqual(["div"]);
  });

  it("skips when the state spans the returned element", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "open" : ""}>
      <h1>Title</h1>
      <p>Body</p>
      <button onClick={() => setOpen(!open)}>toggle</button>
    </div>
  );
}
`);
    expect(f.skipped?.code).toBe("state-spans-component");
  });

  it("reports fully-interactive when the root is the only anchor", async () => {
    const f = await splitOne(`"use client";
export default function Comp({ label }: { label: string }) {
  return <button onClick={() => alert(label)}>{label}</button>;
}
`);
    expect(f.skipped?.code).toBe("fully-interactive");
  });

  it("suggests removing the directive when there are no client markers", async () => {
    const f = await splitOne(`"use client";
export default function Comp({ label }: { label: string }) {
  return <p>{label}</p>;
}
`);
    expect(f.skipped?.code).toBe("no-islands");
  });
});

describe("loops", () => {
  it("makes the mapped element the island and moves the key", async () => {
    const f = await splitOne(`"use client";
export default function Comp({ items }: { items: { id: string; name: string }[] }) {
  return (
    <ul>
      <li>Header</li>
      {items.map((item) => (
        <li key={item.id}>
          <span>{item.name}</span>
          <button onClick={() => console.log(item.id)}>log</button>
        </li>
      ))}
    </ul>
  );
}
`);
    expect(server(f)).toContain("<CompLi key={item.id} item={item} />");
    expect(island(f)).not.toContain("key=");
  });

  it("hoists the island above the .map when it uses component-level state", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ items }: { items: string[] }) {
  const [selected, setSelected] = useState("");
  return (
    <section>
      <h1>Pick one</h1>
      <ul>
        {items.map((item) => (
          <li key={item} onClick={() => setSelected(item)}>{item === selected ? "✓ " : ""}{item}</li>
        ))}
      </ul>
    </section>
  );
}
`);
    expect(f.islands.map((i) => i.rootTag)).toEqual(["ul"]);
    expect(island(f)).toContain("useState");
  });

  it("refuses interactive elements inside other callbacks", async () => {
    const f = await splitOne(`"use client";
export default function Comp({ items }: { items: string[] }) {
  return (
    <ul>
      <li>Header</li>
      {items.filter(Boolean).flatMap((item) => [<li key={item} onClick={() => alert(item)}>{item}</li>])}
    </ul>
  );
}
`);
    expect(f.skipped?.code).toBe("render-prop");
  });
});

describe("import pruning", () => {
  it("keeps partially used imports and removes unused specifiers", async () => {
    const f = await splitOne(`"use client";
import { Fragment, useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  return (
    <Fragment>
      <h1>Title</h1>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </Fragment>
  );
}
`);
    expect(server(f)).toMatch(
      /^import \{ Fragment \} from "react";\nimport \{ CompButton \} from ".\/Comp.client";\n/,
    );
    expect(island(f)).toContain('import { useState } from "react";');
  });

  it("converts to import type when the server only uses a client package's types", async () => {
    const f = await splitOne(`"use client";
import { motion, type Easing } from "framer-motion";
export default function Comp({ title }: { title: string }) {
  const ease: Easing = "easeIn";
  return (
    <div>
      <h1>{title}</h1>
      <p>{ease}</p>
      <motion.p animate={{ opacity: 1 }}>Hi</motion.p>
    </div>
  );
}
`);
    expect(f.status).toBe("split");
    expect(server(f)).toContain('import type { Easing } from "framer-motion";');
    expect(island(f)).toContain('import { motion } from "framer-motion";');
  });

  it("refuses a client-package type that can carry functions as a prop", async () => {
    const f = await splitOne(`"use client";
import { motion, type Variants } from "framer-motion";
export default function Comp({ variants }: { variants: Variants }) {
  return (
    <div>
      <h1>Title</h1>
      <motion.p variants={variants}>Hi</motion.p>
    </div>
  );
}
`);
    expect(f.skipped).toMatchObject({
      code: "non-serializable-prop",
      message: expect.stringContaining("variants"),
    });
  });

  it("keeps stylesheet side-effect imports with the server component", async () => {
    const f = await splitOne(
      `"use client";
import "./styles.css";
import { useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  return (
    <div>
      <h1>Title</h1>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </div>
  );
}
`,
      { "styles.css": "h1 { color: red }" },
    );
    expect(server(f)).toContain('import "./styles.css";');
    expect(island(f)).not.toContain("styles.css");
  });
});
