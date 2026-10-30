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

  it("treats locale- and timezone-dependent formatting as client-only", async () => {
    const f = await splitOne(`"use client";
export default function Comp({ iso, n }: { iso: string; n: number }) {
  return (
    <div>
      <h1>Dates</h1>
      <p>{new Date(iso).toLocaleString()}</p>
      <p>{new Date(iso).toLocaleDateString("en-US")}</p>
      <p>{new Intl.NumberFormat().format(n)}</p>
      <p>{["b", "a"].sort((x, y) => x.localeCompare(y)).join()}</p>
    </div>
  );
}
`);
    expect(f.status).toBe("split");
    expect(f.islands.map((i) => i.rootTag)).toEqual(["p", "p", "p", "p"]);
  });

  it("keeps formatting that names its locale (and timezone, for dates) on the server", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ iso, n }: { iso: string; n: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p>{n.toLocaleString("en-US")}</p>
      <p>{new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC" })}</p>
      <p>{new Intl.DateTimeFormat(["en-GB"], { timeZone: "Europe/London" }).format(new Date(iso))}</p>
      <button onClick={() => setOpen(!open)}>{open ? "-" : "+"}</button>
    </div>
  );
}
`);
    expect(f.islands.map((i) => i.rootTag)).toEqual(["button"]);
    expect(server(f)).toContain('n.toLocaleString("en-US")');
  });
});

describe("object props", () => {
  it("pass only the fields the island reads", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
type Row = { id: string; title: string; body: string };
export default function Comp({ row }: { row: Row }) {
  const [n, setN] = useState(0);
  return (
    <article>
      <p>{row.body}</p>
      <button data-id={row.id} onClick={() => setN(n + 1)}>{row.title} {n}</button>
    </article>
  );
}
`);
    expect(server(f)).toContain("<CompButton row={{ id: row.id, title: row.title }} />");
    expect(island(f)).toContain(
      "export function CompButton({ row }: { row: { id: string; title: string } })",
    );
    expect(island(f)).toContain("{row.title} {n}");
  });

  it("pass the whole object when the island uses it as a whole", async () => {
    for (const use of [
      "{JSON.stringify(row)}",
      "{row?.title}",
      '{row["title"]}',
      "{row.id}{row.title}{row.body}",
    ]) {
      const f = await splitOne(
        `"use client";
import { useState } from "react";
type Row = { id: string; title: string; body: string };
export default function Comp({ row }: { row: Row }) {
  const [n, setN] = useState(0);
  return (
    <article>
      <h1>Static</h1>
      <button onClick={() => setN(n + 1)}>{n}{use}</button>
    </article>
  );
}
`.replace("{use}", use),
      );
      expect(server(f), use).toContain("<CompButton row={row} />");
    }
  });
});

describe("effects", () => {
  it("attach an effect to the island that owns the state it uses", async () => {
    const f = await splitOne(`"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
export default function Comp({ href, title }: { href: string; title: string }) {
  const pathname = usePathname();
  const [active, setActive] = useState(pathname === href);
  useEffect(() => {
    setActive(pathname === href);
  }, [pathname, href]);
  return (
    <li>
      <span>{title}</span>
      <Link href={href} className={active ? "active" : ""}>
        {title}
      </Link>
    </li>
  );
}
`);
    expect(f.status).toBe("split");
    expect(f.islands.map((i) => i.rootTag)).toEqual(["Link"]);
    expect(island(f)).toContain("useEffect(() => {");
    expect(server(f)).not.toContain("useEffect");
  });

  it("never duplicate an effect into per-item list islands", async () => {
    const f = await splitOne(`"use client";
import { useEffect, useState } from "react";
export default function Comp({ items }: { items: string[] }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    document.title = String(count);
  }, [count]);
  return (
    <section>
      <h1>Items</h1>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <button onClick={() => setCount(count + 1)}>{item}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
`);
    expect(f.islands.map((i) => i.rootTag)).toEqual(["ul"]);
  });

  it("give an effect that uses no island's state an island that renders nothing", async () => {
    const f = await splitOne(`"use client";
import { useEffect, useState } from "react";
export default function Comp({ page }: { page: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    document.title = page;
  }, [page]);
  return (
    <div>
      <h1>{page}</h1>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </div>
  );
}
`);
    // Listed by the line their code comes from: the effect's, then the button's.
    expect(f.islands.map((i) => [i.name, i.rootTag, i.effects ?? false])).toEqual([
      ["CompEffects", "effects", true],
      ["CompButton", "button", false],
    ]);
    expect(f.outputs["Comp.tsx"]).toContain(`      <CompButton />
      <CompEffects page={page} />
    </div>`);
    expect(f.outputs["Comp.client.tsx"])
      .toContain(`export function CompEffects({ page }: { page: string }) {
  useEffect(() => {
    document.title = page;
  }, [page]);
  return null;
}`);
  });

  it("add an effects island to a returned fragment, also on one line", async () => {
    const f = await splitOne(`"use client";
import { useEffect } from "react";
export default function Comp({ page }: { page: string }) {
  useEffect(() => {
    document.title = page;
  }, [page]);
  return <><h1>{page}</h1></>;
}
`);
    expect(f.status).toBe("split");
    expect(f.outputs["Comp.tsx"]).toContain(
      "return <><h1>{page}</h1><CompEffects page={page} /></>;",
    );
  });

  it("keep an effect without an island when there's no single element to add one to", async () => {
    const twoReturns = await splitOne(`"use client";
import { useEffect } from "react";
export default function Comp({ page }: { page?: string }) {
  useEffect(() => { document.title = page ?? ""; }, [page]);
  if (!page) return null;
  return <main><h1>{page}</h1></main>;
}
`);
    expect(twoReturns.skipped?.message).toBe(
      "client-only code at line 4 isn't connected to any rendered element, and the component has more than one return; moving it would change when it runs",
    );
    const componentRoot = await splitOne(`"use client";
import { useEffect, type ReactNode } from "react";
function Shell({ children }: { children: ReactNode }) { return <main>{children}</main>; }
export default function Comp({ page }: { page: string }) {
  useEffect(() => { document.title = page; }, [page]);
  return <Shell><h1>{page}</h1></Shell>;
}
`);
    expect(componentRoot.skipped?.message).toContain(
      "and the returned element is the component <Shell>, whose children would change",
    );
    const voidRoot = await splitOne(`"use client";
import { useEffect } from "react";
export default function Comp({ src }: { src: string }) {
  useEffect(() => { console.log(src); }, [src]);
  return <img src={src} alt="" />;
}
`);
    expect(voidRoot.skipped?.message).toContain(
      "and the returned <img /> has no children to add to",
    );
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

  it("allows per-item islands that only read shared context (usePathname)", async () => {
    const f = await splitOne(`"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
export default function Comp({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav>
      <h2>Menu</h2>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={pathname === l.href ? "active" : ""}>{l.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
`);
    expect(f.status).toBe("split");
    expect(server(f)).toContain("<CompLi key={l.href} l={l} />");
    expect(island(f)).toContain("const pathname = usePathname();");
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

describe("arrow-function components", () => {
  it("are not mistaken for module-level values in multi-component files", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
const Icon = () => <svg className="icon" />;
const Comp = ({ title }: { title: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <h2>{title}</h2>
      <Icon />
      <button onClick={() => setOpen(!open)}>{open ? "close" : "open"}</button>
    </section>
  );
};
export default Comp;
`);
    expect(f.skipped).toBeUndefined();
    expect(f.islands.map((i) => i.name)).toEqual(["CompButton"]);
    expect(server(f)).toContain('const Icon = () => <svg className="icon" />;');
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

describe("constants used by an island", () => {
  it("copies body and module constants into the island instead of passing them as props", async () => {
    const f = await splitOne(`"use client";
import { useMemo, useState } from "react";

const RANGES = [
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
] as const;
const INITIAL_FORM = { name: "", email: "" };

export default function Comp({ items }: { items: string[] }) {
  const perPage = 6;
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(INITIAL_FORM);
  const visible = useMemo(() => items.slice(0, page * perPage), [items, page]);
  return (
    <section>
      <h2>Results</h2>
      <div>
        {RANGES.map((r) => <span key={r.id}>{r.label}</span>)}
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <ul>{visible.map((v) => <li key={v}>{v}</li>)}</ul>
        <button onClick={() => setPage(page + 1)}>More</button>
      </div>
    </section>
  );
}
`);
    expect(f.status).toBe("split");
    expect(f.islands).toEqual([expect.objectContaining({ props: ["items"] })]);
    expect(island(f)).toContain("const perPage = 6;");
    expect(island(f)).toContain("const RANGES = [");
    expect(island(f)).toContain('const INITIAL_FORM = { name: "", email: "" };');
    expect(server(f)).not.toMatch(/perPage|RANGES|INITIAL_FORM/);
  });

  it("still passes a body value computed from props", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp({ items }: { items: string[] }) {
  const count = items.length;
  const label = "Count";
  const [open, setOpen] = useState(false);
  return (
    <div>
      <h2>List</h2>
      <button onClick={() => setOpen(!open)}>{open ? \`\${label}: \${count}\` : "?"}</button>
    </div>
  );
}
`);
    expect(f.islands).toEqual([expect.objectContaining({ props: ["count"] })]);
    expect(island(f)).toContain('const label = "Count";');
  });
});

describe("island names", () => {
  it("may reuse the name of a type declared in the file", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";

interface CompForm {
  name: string;
}

export default function Comp() {
  const [form, setForm] = useState<CompForm>({ name: "" });
  return (
    <section>
      <h2>Contact</h2>
      <form onSubmit={() => setForm({ name: "" })}>
        <input value={form.name} onChange={(e) => setForm({ name: e.target.value })} />
      </form>
    </section>
  );
}
`);
    expect(f.status).toBe("split");
    expect(f.islands.map((i) => i.name)).toEqual(["CompForm"]);
  });
});

describe("skip messages", () => {
  it("name the import that makes an element client-only", async () => {
    const f = await splitOne(
      `"use client";
import { cn } from "./utils";
export default function Comp({ title }: { title: string }) {
  return (
    <div className={cn("a", "b")}>
      <h2 className={cn("c")}>{title}</h2>
    </div>
  );
}
`,
      {
        "utils.ts": `export function cn(...c: string[]) { return [...c, uid()].join(" "); }
function uid() { return Math.random().toString(36); }
`,
      },
    );
    expect(f.skipped?.code).toBe("state-spans-component");
    expect(f.skipped?.message).toContain("<div>, <h2>: cn from ./utils is client-only");
    expect(f.skipped?.message).toContain("utils.ts:2 uses Math.random()");
  });

  it("describe an unconnected effect the same way whether or not there are islands", async () => {
    const effectOnly = await splitOne(`"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
export default function Comp({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  if (!children) return null;
  return <main><h1>Site</h1>{children}</main>;
}
`);
    const withIsland = await splitOne(`"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
export default function Comp({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  if (!children) return null;
  return <main><h1>Site</h1><button onClick={() => setOpen(!open)}>menu</button>{children}</main>;
}
`);
    for (const f of [effectOnly, withIsland]) {
      expect(f.skipped?.code).toBe("unsupported-pattern");
      expect(f.skipped?.message).toMatch(
        /^client-only code at line 5 isn't connected to any rendered element, and the component has more than one return; moving it would change when it runs$/,
      );
    }
  });
});

describe("let with assignments right after it", () => {
  it("moves a let computed from state into the island, and keeps one computed from props", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";

export default function Comp({ title, featured }: { title: string; featured: boolean }) {
  const [on, setOn] = useState(false);
  let label = "Off";
  if (on) label = "On";

  let cls = "card";
  if (featured) {
    cls += " featured";
  } else if (title.length > 10) {
    cls += " long";
  }
  return (
    <section className={cls}>
      <h2>{title}</h2>
      <button onClick={() => setOn(!on)}>{label}</button>
    </section>
  );
}
`);
    expect(f.status).toBe("split");
    expect(f.islands.map((i) => [i.rootTag, i.props])).toEqual([["button", []]]);
    expect(f.outputs["Comp.client.tsx"]).toContain(`export function CompButton() {
  const [on, setOn] = useState(false);
  let label = "Off";
  if (on) label = "On";

  return <button onClick={() => setOn(!on)}>{label}</button>;
}`);
    const server = f.outputs["Comp.tsx"] ?? "";
    expect(server).not.toContain("let label");
    expect(server).toContain(`  let cls = "card";
  if (featured) {
    cls += " featured";
  } else if (title.length > 10) {
    cls += " long";
  }`);
  });

  it("passes a let computed on the server to an island as a prop", async () => {
    const f = await splitOne(`"use client";
import { useState } from "react";

export default function Comp({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  let noun = "items";
  if (count === 1) noun = "item";
  return (
    <div>
      <h2>Basket</h2>
      <button onClick={() => setOpen(!open)}>
        {count} {noun}
      </button>
    </div>
  );
}
`);
    expect(f.status).toBe("split");
    expect(f.islands[0]?.props).toEqual(["count", "noun"]);
  });

  it("refuses a let that's assigned later, and hooks while computing it", async () => {
    const later = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  let total = 0;
  const bump = () => { total = n + 1; setN(total); };
  return <div><h2>Title</h2><button onClick={bump}>{n}</button></div>;
}
`);
    expect(later.skipped).toMatchObject({ code: "unsupported-pattern" });
    expect(later.skipped?.message).toContain(
      "`total` is assigned at line 6; a `let` is supported when it's only assigned right after its declaration",
    );
    const hook = await splitOne(`"use client";
import { useState, useId } from "react";
export default function Comp({ id }: { id?: string }) {
  const [n, setN] = useState(0);
  let key = id;
  if (!key) key = useId();
  return <div><h2>{key}</h2><button onClick={() => setN(n + 1)}>{n}</button></div>;
}
`);
    expect(hook.skipped).toMatchObject({ code: "conditional-hooks-or-returns" });
    const v = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  var x = 1;
  return <div><h2>{x}</h2><button onClick={() => setN(n + 1)}>{n}</button></div>;
}
`);
    expect(v.skipped?.message).toBe("declares a `var` in the component body");
  });
});

describe("effects islands keep effect order", () => {
  it("refuses when an island's effect is declared after the effect that would move", async () => {
    const before = await splitOne(`"use client";
import { useEffect, useState } from "react";
export default function Comp({ title }: { title: string }) {
  useEffect(() => { document.title = title; }, [title]);
  const [open, setOpen] = useState(false);
  useEffect(() => { document.title = open ? "open" : "closed"; }, [open]);
  return (
    <main>
      <h1>{title}</h1>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </main>
  );
}
`);
    expect(before.skipped?.message).toBe(
      "client-only code at line 4 isn't connected to any rendered element, and useEffect() at line 6 (in the island <button> (line 10)) is declared after it, so its effects would run first; moving it would change when it runs",
    );
    const after = await splitOne(`"use client";
import { useEffect, useState } from "react";
export default function Comp({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { document.title = open ? "open" : "closed"; }, [open]);
  useEffect(() => { document.title = title; }, [title]);
  return (
    <main>
      <h1>{title}</h1>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </main>
  );
}
`);
    expect(after.islands.map((i) => i.name)).toEqual(["CompEffects", "CompButton"]);
  });
});

describe("let writes", () => {
  it("refuses a let written by destructuring or a for-of loop", async () => {
    for (const write of ['[label] = ["On"];', 'for (label of ["a"]) {}']) {
      const f = await splitOne(`"use client";
import { useState } from "react";
export default function Comp() {
  const [n, setN] = useState(0);
  let label = "Off";
  const update = () => { ${write} };
  return <div><h2>{label}</h2><button onClick={() => { update(); setN(n + 1); }}>{n}</button></div>;
}
`);
      expect(f.skipped?.message, write).toContain("`label` is assigned at line 6");
    }
  });
});
