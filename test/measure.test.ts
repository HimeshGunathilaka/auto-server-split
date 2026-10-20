import { describe, expect, it } from "vitest";
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

  it("reports the estimate on every measured split", async () => {
    const result = await splitOne(tiny, {}, { minBytesSaved: 0 }, true);
    expect(result.status).toBe("split");
    expect(result.bytesSaved?.conservative).toBeGreaterThanOrEqual(0);
    expect(result.measureError).toBeUndefined();
  });
});
