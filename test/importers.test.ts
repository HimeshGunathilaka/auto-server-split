import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { split } from "../src/index.js";

/**
 * Importers outside the TypeScript project (excluded by the tsconfig, or not a TS/JS file) have no
 * type information. They're checked syntactically: rendering the component as JSX is fine, anything
 * that can't be verified skips as `unsupported-pattern`, and only real client modules give
 * `imported-by-client`.
 */

const TMP = path.resolve(import.meta.dirname, ".tmp");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    lib: ["dom", "esnext"],
    module: "esnext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ["**/*.ts", "**/*.tsx"],
  exclude: ["**/*.test.tsx", "legacy"],
});

const CARD = `"use client";
import { useState } from "react";

export function Card({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2>{title}</h2>
      <p>Static text</p>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`;

const PAGE = `import { Card } from "../components/Card";
export default function Page() {
  return <Card title="t" />;
}
`;

async function cardResult(extra: Record<string, string>) {
  const root = path.join(TMP, `importers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(root);
  const files = {
    "tsconfig.json": TSCONFIG,
    "components/Card.tsx": CARD,
    "app/page.tsx": PAGE,
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const result = await split({
    root,
    paths: ["components/Card.tsx"],
    measure: false,
    noConfigFile: true,
    config: { minBytesSaved: 0 },
  });
  const [card] = result.files;
  if (card?.skipped?.code === "internal-error") throw new Error(card.skipped.message);
  return card;
}

describe("importers outside the TypeScript project", () => {
  it("allow a split when they render the component as JSX", async () => {
    const card = await cardResult({
      "components/__tests__/Card.test.tsx": `import { Card } from "../Card";
import * as Cards from "../Card";
export const cases = [<Card title="a" />, <Cards.Card title="b" />];
`,
      "legacy/Old.jsx": `import { Card } from "../components/Card";
export default function Old() {
  return <Card title="old" />;
}
`,
    });
    expect(card?.status).toBe("split");
  });

  it("skip as unsupported-pattern when they use the component as a value", async () => {
    const card = await cardResult({
      "components/__tests__/Card.test.tsx": `import { Card } from "../Card";
export const registry = { card: Card };
`,
    });
    expect(card?.skipped).toMatchObject({
      code: "unsupported-pattern",
      message:
        "Card is used as a value in components/__tests__/Card.test.tsx:2; only <Card /> usage can be verified",
    });
  });

  it("follow barrels outside the project", async () => {
    const barrel = {
      "legacy/index.ts": `export { Card as LegacyCard } from "../components/Card";\n`,
    };
    const asJsx = await cardResult({
      ...barrel,
      "legacy/Use.tsx": `import { LegacyCard } from "./index";\nexport const el = <LegacyCard title="x" />;\n`,
    });
    expect(asJsx?.status).toBe("split");
    const asValue = await cardResult({
      ...barrel,
      "legacy/Use.tsx": `import { LegacyCard } from "./index";\nexport const C = LegacyCard;\n`,
    });
    expect(asValue?.skipped?.code).toBe("unsupported-pattern");
    expect(asValue?.skipped?.message).toContain(
      "LegacyCard is used as a value in legacy/Use.tsx:2",
    );
  });

  it("skip as unsupported-pattern for require() and MDX, which can't be verified", async () => {
    const required = await cardResult({
      "legacy/req.js": `const { Card } = require("../components/Card");\nmodule.exports = Card;\n`,
    });
    expect(required?.skipped).toMatchObject({
      code: "unsupported-pattern",
      message: "legacy/req.js:1 loads it with require(), so its usage can't be verified",
    });
    const mdx = await cardResult({
      "app/docs/page.mdx": `import { Card } from "../../components/Card";\n\n<Card title="docs" />\n`,
    });
    expect(mdx?.skipped).toMatchObject({
      code: "unsupported-pattern",
      message: "imported by app/docs/page.mdx; how MDX files use a component can't be verified",
    });
  });

  it("still skip as imported-by-client when they are client modules", async () => {
    const card = await cardResult({
      "legacy/Panel.tsx": `"use client";\nimport { Card } from "../components/Card";\nexport const Panel = () => <Card title="p" />;\n`,
    });
    expect(card?.skipped).toMatchObject({
      code: "imported-by-client",
      message: "imported by legacy/Panel.tsx (client)",
    });
  });
});
