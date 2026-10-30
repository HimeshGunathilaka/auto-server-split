import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/config.js";
import { createRunContext } from "../src/split.js";
import { splitOne } from "./helpers.js";

const card = (imports: string, title: string) => `"use client";
import { useState } from "react";
${imports}
export default function Card({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
      <h2>${title}</h2>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </article>
  );
}
`;

describe("module safety per export", () => {
  it("keeps a pure export on the server when a sibling export uses browser APIs", async () => {
    const result = await splitOne(
      card('import { formatTitle } from "./utils";', "{formatTitle(title)}"),
      {
        "utils.ts": `export const formatTitle = (t: string) => t.toUpperCase();
export function copy(text: string) {
  return navigator.clipboard.writeText(text);
}
`,
      },
    );
    expect(result.status).toBe("split");
    expect(result.outputs["Comp.tsx"]).toContain("<h2>{formatTitle(title)}</h2>");
    expect(result.islands.map((i) => i.rootTag)).toEqual(["button"]);
  });

  it("follows the declarations an export uses", async () => {
    const result = await splitOne(
      card('import { formatTitle } from "./utils";', "{formatTitle(title)}"),
      {
        "utils.ts": `const suffix = () => (typeof window === "undefined" ? "" : window.name);
export const formatTitle = (t: string) => t + suffix();
`,
      },
    );
    // The heading needs formatTitle, so it moves into an island with the button.
    expect(result.islands.map((i) => i.rootTag)).toEqual(["h2", "button"]);
  });

  it("treats a module that imports a client-only React API by name as client-only", async () => {
    const result = await splitOne(
      card('import { formatTitle } from "./utils";', "{formatTitle(title)}"),
      {
        "utils.ts": `import { useState } from "react";
export const formatTitle = (t: string) => t.toUpperCase();
export function useToggle() {
  return useState(false);
}
`,
      },
    );
    expect(result.islands.map((i) => i.rootTag)).toEqual(["h2", "button"]);
  });

  it("ignores React types imported without `type`", async () => {
    const result = await splitOne(
      card('import { formatTitle } from "./utils";', "{formatTitle(title)}"),
      {
        "utils.ts": `import { AnchorHTMLAttributes, ReactNode } from "react";
export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode };
export const formatTitle = (t: string) => t.toUpperCase();
`,
      },
    );
    expect(result.islands.map((i) => i.rootTag)).toEqual(["button"]);
  });

  it("checks the local functions and classes that run when the module is imported", async () => {
    const cases = {
      call: `function readTheme() { return localStorage.getItem("theme"); }
export const theme = readTheme();`,
      iife: `const platform = (() => window.navigator.platform)();
export const isMac = () => platform === "MacIntel";`,
      extends: `export class CopyButton extends HTMLElement {}`,
      staticField: `export class Settings { static theme = localStorage.getItem("theme"); }`,
      mutation: `export const registry: Record<string, () => string> = {};
registry.href = () => window.location.href;`,
      callback: `const ready: string[] = [];
[1].forEach(() => ready.push(document.title));`,
    };
    for (const [name, code] of Object.entries(cases)) {
      const result = await splitOne(
        card('import { formatTitle } from "./utils";', "{formatTitle(title)}"),
        { "utils.ts": `${code}\nexport const formatTitle = (t: string) => t.toUpperCase();\n` },
      );
      // The heading can't render on the server: importing utils there would run that code.
      expect(
        result.islands.map((i) => i.rootTag),
        name,
      ).toEqual(["h2", "button"]);
    }
  });

  it("doesn't cache an answer it assumed inside an import cycle", async () => {
    const result = await splitOne(
      `"use client";
import { useState } from "react";
import { crumbs } from "./a";
import { trail } from "./b";
export default function Card({ depth }: { depth: number }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
      <h2>{crumbs(depth)}</h2>
      <p>{trail(depth)}</p>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </article>
  );
}
`,
      {
        "a.ts": `import { trail } from "./b";
export const crumbs = (n: number): string => (n > 0 ? trail(n - 1) : window.location.pathname);
`,
        "b.ts": `import { crumbs } from "./a";
export const trail = (n: number): string => crumbs(n);
`,
      },
    );
    expect(result.islands.map((i) => i.rootTag)).toEqual(["h2", "p", "button"]);
  });

  it("keeps a Client Component re-exported through a barrel a client reference", async () => {
    const result = await splitOne(
      card('import { Badge } from "./ui";', "<Badge label={title} />"),
      {
        "ui/index.ts": 'export { Badge } from "./Badge";\n',
        "ui/Badge.tsx": `"use client";
export function Badge({ label }: { label: string }) {
  return <span onClick={() => console.log(label)}>{label}</span>;
}
`,
      },
    );
    expect(result.islands.map((i) => i.rootTag)).toEqual(["button"]);
    expect(result.outputs["Comp.tsx"]).toContain("<Badge label={title} />");
  });

  it("allows hooks reached through the React namespace in other exports", async () => {
    const result = await splitOne(
      card('import { formatTitle } from "./utils";', "{formatTitle(title)}"),
      {
        "utils.ts": `import * as React from "react";
export const formatTitle = (t: string) => t.toUpperCase();
export function useToggle() {
  return React.useState(false);
}
`,
      },
    );
    expect(result.status).toBe("split");
  });

  it("follows re-exports to the module that declares the export", async () => {
    const result = await splitOne(
      card('import { formatTitle } from "./lib";', "{formatTitle(title)}"),
      {
        "lib/index.ts": `export { formatTitle, copy } from "./text";\n`,
        "lib/text.ts": `export const formatTitle = (t: string) => t.toUpperCase();
export function copy(text: string) {
  return navigator.clipboard.writeText(text);
}
`,
      },
    );
    expect(result.status).toBe("split");
  });

  it("keeps module-level code that reads browser globals client-only", async () => {
    const result = await splitOne(
      card('import { formatTitle } from "./utils";', "{formatTitle(title)}"),
      {
        "utils.ts": `const wide = window.innerWidth > 600;
export const formatTitle = (t: string) => t.toUpperCase();
export const isWide = () => wide;
`,
      },
    );
    expect(result.islands.map((i) => i.rootTag)).toEqual(["h2", "button"]);
  });
});

describe("ModuleSafety.check", () => {
  const root = path.join(import.meta.dirname, ".tmp", `safety-${process.pid}`);
  const write = (files: Record<string, string>) => {
    rmSync(root, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    return createRunContext(realpathSync(root), resolveConfig({ include: ["**"] }));
  };
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("explains why an export or its module can't be used on the server", () => {
    const run = write({
      "utils.ts": `import { useState } from "react";
const wide = () => window.innerWidth > 600;
export const formatTitle = (t: string) => t.toUpperCase();
export const label = (t: string) => (wide() ? t : t.slice(0, 3));
export const useToggle = () => useState(false);
`,
      "pure.ts": `const wide = () => window.innerWidth > 600;
export const formatTitle = (t: string) => t.toUpperCase();
export const label = (t: string) => (wide() ? t : t.slice(0, 3));
`,
    });
    const file = (f: string) => path.join(run.root, f);
    expect(run.moduleSafety.check(file("utils.ts"), "formatTitle")).toEqual({
      safe: false,
      reason: "utils.ts:1 imports React.useState only works in Client Components",
    });
    expect(run.moduleSafety.check(file("pure.ts"), "formatTitle")).toEqual({ safe: true });
    expect(run.moduleSafety.check(file("pure.ts"), "label")).toEqual({
      safe: false,
      reason: "pure.ts:1 uses window",
    });
    expect(run.moduleSafety.check(file("pure.ts"))).toEqual({
      safe: false,
      reason: "pure.ts:1 uses window",
    });
  });
});
