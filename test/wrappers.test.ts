import { describe, expect, it } from "vitest";
import { splitOne } from "./helpers.js";

const server = (result: Awaited<ReturnType<typeof splitOne>>) => result.outputs["Comp.tsx"] ?? "";

describe("memo() and forwardRef()", () => {
  it("unwraps memo() around an exported arrow component", async () => {
    const result = await splitOne(`"use client";
import { memo, useState } from "react";

export const Card = memo(({ title }: { title: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <h2>{title}</h2>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </div>
  );
});
`);
    expect(result.status).toBe("split");
    expect(server(result)).toContain("export const Card = ({ title }: { title: string }) => {");
    expect(server(result)).not.toContain("memo");
  });

  it("removes memo() along with the directive when nothing is client-only", async () => {
    const result = await splitOne(
      `"use client";
import { memo, type ReactNode } from "react";

function Label({ text }: { text: string }): ReactNode {
  return <span>{text}</span>;
}

export default memo(Label);
`,
      {},
      { removeUnusedDirectives: true },
    );
    expect(result.status).toBe("directive-removed");
    expect(server(result)).toBe(`import type { ReactNode } from "react";

function Label({ text }: { text: string }): ReactNode {
  return <span>{text}</span>;
}

export default Label;
`);
  });

  it("keeps a forwardRef() whose function uses the ref", async () => {
    const result = await splitOne(`"use client";
import { forwardRef, useState } from "react";

export const Input = forwardRef<HTMLInputElement, { label: string }>(function Input({ label }, ref) {
  const [value, setValue] = useState("");
  return (
    <label>
      {label}
      <input ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
    </label>
  );
});
`);
    expect(result.skipped).toMatchObject({ code: "hoc" });
    expect(result.skipped?.message).toContain("uses the ref that forwardRef() passes it");
  });

  it("sees a ref used through object shorthand", async () => {
    const result = await splitOne(`"use client";
import { forwardRef, useState } from "react";

export const Box = forwardRef<HTMLDivElement, { title: string }>(function Box({ title }, ref) {
  const [open, setOpen] = useState(false);
  const target = { ref };
  return (
    <section>
      <h2>{title}</h2>
      <div ref={target.ref} onClick={() => setOpen(!open)}>{String(open)}</div>
    </section>
  );
});
`);
    expect(result.skipped).toMatchObject({ code: "hoc" });
    expect(result.skipped?.message).toContain("uses the ref that forwardRef() passes it");
  });

  it("asks for a parameter type when only the memo() call types the props", async () => {
    const result = await splitOne(`"use client";
import { memo, useState, type FC } from "react";

export const Card = memo<FC<{ title: string }>>((props) => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <h2>{props.title}</h2>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </div>
  );
});
`);
    expect(result.skipped).toMatchObject({ code: "hoc" });
    expect(result.skipped?.message).toContain("add a type to its parameter");
  });

  it("unwraps memo() around a component declared elsewhere, through a const", async () => {
    const inner = `"use client";
import { memo, useState } from "react";

function Inner({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <h2>{title}</h2>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </div>
  );
}
`;
    const viaDefault = await splitOne(
      `${inner}\nconst Card = memo(Inner);\nexport default Card;\n`,
    );
    expect(viaDefault.status).toBe("split");
    expect(server(viaDefault)).toContain("const Card = Inner;\nexport default Card;");
    const named = await splitOne(`${inner}\nexport const Card = memo(Inner);\n`);
    expect(named.status).toBe("split");
    expect(server(named)).toContain("export const Card = Inner;");
    expect(server(named)).not.toContain("memo");
    const plain = await splitOne(`${inner}\nexport const Card = Inner;\n`);
    expect(plain.status).toBe("split");
  });

  it("still skips memo() around a component from another module", async () => {
    const result = await splitOne(
      `"use client";
import { memo } from "react";
import { Inner } from "./Inner";

export const Card = memo(Inner);
`,
      { "Inner.tsx": "export function Inner() {\n  return <p>hi</p>;\n}\n" },
    );
    expect(result.skipped).toMatchObject({ code: "hoc" });
    expect(result.skipped?.message).toContain("Inner isn't a component declared in this file");
  });

  it("splits an anonymous default-exported arrow component, named after its file", async () => {
    const result = await splitOne(`"use client";
import { useState } from "react";

export default ({ text }: { text: string }) => {
  const [n, setN] = useState(0);
  return (
    <span>
      <i>{text}</i>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </span>
  );
};
`);
    expect(result.status).toBe("split");
    expect(result.islands.map((i) => i.name)).toEqual(["CompButton"]);
  });

  it("drops an inline memo() comparison function", async () => {
    const result = await splitOne(`"use client";
import { memo, useState } from "react";

export const Card = memo(
  function Card({ title }: { title: string }) {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <h2>{title}</h2>
        <button onClick={() => setOpen(!open)}>{String(open)}</button>
      </div>
    );
  },
  (a, b) => a.title === b.title,
);
`);
    expect(result.status).toBe("split");
    expect(server(result)).not.toContain("a.title === b.title");
    expect(server(result)).not.toContain("memo");
  });
});
