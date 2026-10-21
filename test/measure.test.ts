import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { split } from "../src/index.js";
import type { FileResult, UserConfig } from "../src/types.js";
import { splitOne } from "./helpers.js";

// TypeScript resolves "virtual-fmt" through the ambient declaration; esbuild can't bundle it.
const unbundleable = {
  source: `"use client";
import { useState } from "react";
import { fmt } from "virtual-fmt";

export default function Card({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2>{fmt(title)}</h2>
      <p>Some static text</p>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`,
  extra: {
    "virtual.d.ts": `declare module "virtual-fmt" { export function fmt(s: string): string; }\n`,
  },
};

// esbuild has no loader for .md files.
const noLoader = {
  source: `"use client";
import { useState } from "react";
import notes from "./notes.md";

export default function Notes() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <pre>{notes}</pre>
      <p>Static</p>
      <button onClick={() => setOpen(!open)}>{open ? "close" : "open"}</button>
    </section>
  );
}
`,
  extra: {
    "notes.md": "# Notes\n",
    "md.d.ts": `declare module "*.md" { const text: string; export default text; }\n`,
  },
};

const tiny = `"use client";
import { useState } from "react";

export default function Tiny() {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2>Title</h2>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`;

describe("size measurement", () => {
  for (const [name, input, reason] of [
    ["an unresolvable module", unbundleable, 'Could not resolve "virtual-fmt"'],
    ["a file esbuild has no loader for", noLoader, 'No loader is configured for ".md" files'],
  ] as const) {
    describe(`when esbuild can't bundle ${name}`, () => {
      it("skips as measure-failed while minBytesSaved is set", async () => {
        const result = await splitOne(input.source, input.extra, { minBytesSaved: 2048 }, true);
        expect(result.status).toBe("skipped");
        expect(result.skipped?.code).toBe("measure-failed");
        expect(result.skipped?.message).toContain(reason);
        expect(result.skipped?.message).toContain("minBytesSaved (2.0 KB) can't be checked");
        expect(result.outputs).toEqual({});
      });

      it("splits, labelled as unmeasured, when minBytesSaved is 0", async () => {
        const result = await splitOne(input.source, input.extra, { minBytesSaved: 0 }, true);
        expect(result.status).toBe("split");
        expect(result.bytesSaved).toBeUndefined();
        expect(result.measureError).toContain(reason);
      });

      it("splits without a measurement when measuring is off", async () => {
        const result = await splitOne(input.source, input.extra, { minBytesSaved: 2048 }, false);
        expect(result.status).toBe("split");
        expect(result.bytesSaved).toBeUndefined();
        expect(result.measureError).toBeUndefined();
      });
    });
  }

  it("still applies minBytesSaved to a measured saving", async () => {
    const result = await splitOne(tiny, {}, { minBytesSaved: 2048 }, true);
    expect(result.skipped?.code).toBe("below-threshold");
    expect(result.skipped?.message).toMatch(/^saves an estimated \d+ B gzip/);
  });

  it("measures a component that imports a CSS Module", async () => {
    const source = `"use client";
import { useState } from "react";
import styles from "./Card.module.css";

export default function Card({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <section className={styles.card}>
      <h2 className={styles.title}>{title}</h2>
      <p>Some static text</p>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`;
    const extra = {
      "Card.module.css": ".card { padding: 1rem; }\n.title { font-weight: 600; }\n",
      "css.d.ts": `declare module "*.module.css" { const c: Record<string, string>; export default c; }\n`,
    };
    const result = await splitOne(source, extra, { minBytesSaved: 2048 }, true);
    expect(result.skipped?.code).not.toBe("measure-failed");
    expect(result.measureError).toBeUndefined();
  });

  it("measures a component that imports a Server Action module", async () => {
    // The action module imports a Node built-in, as a database driver would. In the client bundle
    // the import becomes a server reference, so the measurement must not follow it.
    const source = `"use client";
import { useState } from "react";
import { save } from "./actions";

export default function Card({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2>{title}</h2>
      <p>Some static text</p>
      <button onClick={() => save(n).then(() => setN(n + 1))}>{n}</button>
    </section>
  );
}
`;
    const extra = {
      "actions.ts": `"use server";
import { connect } from "net";
export async function save(n: number): Promise<void> {
  connect(5432).end(String(n));
}
`,
      "net.d.ts": `declare module "net" { export function connect(port: number): { end(s: string): void }; }\n`,
    };
    const result = await splitOne(source, extra, { minBytesSaved: 0 }, true);
    expect(result.status).toBe("split");
    expect(result.measureError).toBeUndefined();
    expect(result.bytesSaved).toBeDefined();
  });

  it("reports the estimate on every measured split", async () => {
    const result = await splitOne(tiny, {}, { minBytesSaved: 0 }, true);
    expect(result.status).toBe("split");
    expect(result.bytesSaved?.conservative).toBeGreaterThanOrEqual(0);
    expect(result.measureError).toBeUndefined();
  });
});

/** Two cards that use the same packages (date-fns and marked), like PostCard and LintA. */
const card = (name: string) => `"use client";
import { format } from "date-fns";
import { marked } from "marked";
import { useState } from "react";

export function ${name}({ title, date, body }: { title: string; date: string; body: string }) {
  const [liked, setLiked] = useState(false);
  return (
    <article>
      <h2>{title}</h2>
      <time>{format(new Date(date), "PPP")}</time>
      <div dangerouslySetInnerHTML={{ __html: marked(body) as string }} />
      <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>
    </article>
  );
}
`;

/** Imports date-fns but can't be split (it exports a constant), so date-fns keeps shipping. */
const STAYS_CLIENT = `"use client";
import { formatDistance } from "date-fns";
export const LABEL = "x";
export function Ago({ date }: { date: string }) {
  return <span onClick={() => alert(1)}>{formatDistance(new Date(date), new Date(0))}</span>;
}
`;

const projects: string[] = [];
afterAll(() => {
  for (const d of projects) rmSync(d, { recursive: true, force: true });
});

async function measured(
  files: Record<string, string>,
  config: UserConfig = {},
  paths = ["components"],
): Promise<Map<string, FileResult>> {
  const root = path.resolve(
    import.meta.dirname,
    ".tmp",
    `estimate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  projects.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const result = await split({ root, paths, noConfigFile: true, config });
  for (const f of result.files)
    if (f.skipped?.code === "internal-error") throw new Error(f.skipped.message);
  return new Map(result.files.map((f) => [f.file, f]));
}

describe("estimates across splits", () => {
  const pair = {
    "components/A.tsx": card("A"),
    "components/B.tsx": card("B"),
  };

  it("splits components that share a dependency at the default threshold", async () => {
    const results = await measured(pair);
    const a = results.get("components/A.tsx");
    const b = results.get("components/B.tsx");
    expect(a?.status).toBe("split");
    expect(b?.status).toBe("split");
    expect(a?.bytesSaved?.sharedWith).toEqual(["components/B.tsx"]);
    expect(b?.bytesSaved?.sharedWith).toEqual(["components/A.tsx"]);
    // The shared packages are counted once, half each: together about what one split alone saves.
    const alone = (await measured({ "components/A.tsx": card("A") })).get("components/A.tsx");
    const together = (a?.bytesSaved?.conservative ?? 0) + (b?.bytesSaved?.conservative ?? 0);
    expect(alone?.bytesSaved?.sharedWith).toBeUndefined();
    expect(Math.abs(together - (alone?.bytesSaved?.conservative ?? 0))).toBeLessThan(400);
    expect(a?.bytesSaved?.conservative).toBeGreaterThan(2048);
  });

  it("gives the same estimate whichever paths the run covers", async () => {
    const both = await measured(pair);
    const one = await measured(pair, {}, ["components/A.tsx"]);
    expect(one.get("components/A.tsx")?.bytesSaved).toEqual(
      both.get("components/A.tsx")?.bytesSaved,
    );
    expect(one.has("components/B.tsx")).toBe(false);
  });

  it("leaves out a package another client module still ships", async () => {
    const results = await measured({ ...pair, "components/Ago.tsx": STAYS_CLIENT });
    const a = results.get("components/A.tsx");
    const withDateFns = (await measured(pair)).get("components/A.tsx");
    expect(results.get("components/Ago.tsx")?.skipped?.code).toBe("exports-non-components");
    expect(a?.status).toBe("split");
    expect(a?.bytesSaved?.conservative).toBeLessThan(
      (withDateFns?.bytesSaved?.conservative ?? 0) - 1000,
    );
  });

  it("drops splits below minBytesSaved until the rest still pass on their own", async () => {
    // B only removes date-fns, which it shares with A. At this threshold B falls below it, so
    // date-fns keeps shipping with B and A's estimate is what it is when B can't be split at all.
    const dateOnly = `"use client";
import { format } from "date-fns";
import { useState } from "react";
export function B({ date }: { date: string }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <time>{format(new Date(date), "PPP")}</time>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`;
    const files = { "components/A.tsx": card("A"), "components/B.tsx": dateOnly };
    const loose = await measured(files, { minBytesSaved: 0 });
    expect(loose.get("components/A.tsx")?.bytesSaved?.sharedWith).toEqual(["components/B.tsx"]);
    const threshold = (loose.get("components/B.tsx")?.bytesSaved?.conservative ?? 0) + 1;
    const strict = await measured(files, { minBytesSaved: threshold });
    expect(strict.get("components/B.tsx")?.skipped?.code).toBe("below-threshold");
    const bStaysClient = await measured({
      "components/A.tsx": card("A"),
      "components/B.tsx": dateOnly.replace('"use client";', '"use client";\nexport const x = 1;'),
    });
    const a = strict.get("components/A.tsx");
    expect(a?.status).toBe("split");
    expect(a?.bytesSaved?.sharedWith).toBeUndefined();
    expect(a?.bytesSaved?.conservative).toBe(
      bStaysClient.get("components/A.tsx")?.bytesSaved?.conservative,
    );
  });

  it("counts a package's own dependencies as shipping while the package does", async () => {
    const big = `export const blob = ${JSON.stringify("x".repeat(20000).replace(/x/g, () => Math.random().toString(36).slice(2, 3)))};\n`;
    const files = {
      "node_modules/fake-a/package.json": JSON.stringify({ name: "fake-a", main: "index.js" }),
      "node_modules/fake-a/index.js": `import { blob } from "fake-b";\nexport const pick = (n) => blob.slice(0, n);\n`,
      "node_modules/fake-a/index.d.ts": "export declare const pick: (n: number) => string;\n",
      "node_modules/fake-b/package.json": JSON.stringify({ name: "fake-b", main: "index.js" }),
      "node_modules/fake-b/index.js": big,
      "components/A.tsx": `"use client";
import { pick } from "fake-a";
import { useState } from "react";
export function A() {
  const [n, setN] = useState(0);
  return (
    <section>
      <p>{pick(3)}</p>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`,
      // fake-a (and so fake-b) keeps shipping with this one.
      "components/Keep.tsx": `"use client";
import { pick } from "fake-a";
export const K = 1;
export function Keep() {
  return <span onClick={() => alert(pick(1))}>keep</span>;
}
`,
    };
    const a = (await measured(files, { minBytesSaved: 0 })).get("components/A.tsx");
    expect(a?.status).toBe("split");
    expect(a?.bytesSaved?.isolated).toBeGreaterThan(5000);
    expect(a?.bytesSaved?.conservative).toBeLessThan(500);
  });
});
