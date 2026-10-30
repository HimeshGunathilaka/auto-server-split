import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { split } from "../src/index.js";
import { findWorkspaceProjects, prefixResult, workspaceGlobs } from "../src/workspace.js";

const tmp = path.join(import.meta.dirname, ".tmp", `workspace-${process.pid}`);
let root = "";

const tsconfig = JSON.stringify({
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
});

beforeAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "repo",
      private: true,
      workspaces: ["apps/*", "packages/*"],
    }),
    "packages/ui/package.json": JSON.stringify({
      name: "@acme/ui",
      main: "src/index.ts",
      peerDependencies: { react: "*" },
    }),
    "packages/ui/src/index.ts":
      'export { Badge } from "./Badge";\nexport { Toggle } from "./Toggle";\n',
    "packages/ui/src/Badge.tsx":
      "export function Badge({ text }: { text: string }) {\n  return <strong>{text}</strong>;\n}\n",
    "packages/ui/src/Toggle.tsx": `"use client";
import { useState } from "react";
export function Toggle() {
  const [on, setOn] = useState(false);
  return <button onClick={() => setOn(!on)}>{String(on)}</button>;
}
`,
    "apps/web/package.json": JSON.stringify({
      name: "web",
      dependencies: { next: "*", "@acme/ui": "workspace:*" },
    }),
    "apps/web/tsconfig.json": tsconfig,
    "apps/web/app/page.tsx":
      'import Card from "../components/Card";\nexport default function Page() {\n  return <Card title="Hi" />;\n}\n',
    "apps/web/components/Card.tsx": `"use client";
import { Badge } from "@acme/ui";
import { useState } from "react";

export default function Card({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
      <h2>
        <Badge text={title} />
      </h2>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </article>
  );
}
`,
    "apps/docs/package.json": JSON.stringify({ name: "docs" }),
    // Built output with a "use client" banner; only the types point at the source.
    "packages/kit/package.json": JSON.stringify({
      name: "@acme/kit",
      main: "dist/index.js",
      types: "src/index.ts",
    }),
    "packages/kit/src/index.ts": "export const formatPrice = (n: number) => `$${n}`;\n",
    "packages/kit/dist/index.js": '"use client";\nexport const formatPrice = (n) => `$${n}`;\n',
    "apps/web/components/Price.tsx": `"use client";
import { formatPrice } from "@acme/kit";
import { useState } from "react";

export default function Price({ cents }: { cents: number }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
      <h2>{formatPrice(cents)}</h2>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </article>
  );
}
`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    writeFileSync(path.join(tmp, rel), text);
  }
  mkdirSync(path.join(tmp, "apps/web/node_modules/@acme"), { recursive: true });
  for (const pkg of ["ui", "kit"])
    symlinkSync(
      path.join(tmp, "packages", pkg),
      path.join(tmp, "apps/web/node_modules/@acme", pkg),
      "dir",
    );
  root = realpathSync(tmp);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("workspaces", () => {
  it("finds the Next.js apps among the workspace packages", () => {
    expect(workspaceGlobs(root)).toEqual(["apps/*", "packages/*"]);
    expect(findWorkspaceProjects(root, undefined)).toEqual({
      projects: [{ dir: path.join(root, "apps/web"), name: "apps/web" }],
    });
    // A glob picks the apps it matches; apps/docs and packages/ui aren't apps.
    expect(findWorkspaceProjects(root, ["apps/*", "packages/*"])).toEqual({
      projects: [{ dir: path.join(root, "apps/web"), name: "apps/web" }],
    });
  });

  it("refuses a named directory that isn't an app, and takes . as the root", () => {
    expect(findWorkspaceProjects(root, ["apps/docs"])).toEqual({
      error: expect.stringContaining("apps/docs isn't a Next.js App Router app"),
    });
    const web = path.join(root, "apps/web");
    expect(findWorkspaceProjects(web, ["."])).toEqual({ projects: [{ dir: web, name: "" }] });
  });

  it("analyses a linked workspace package from its source", async () => {
    const result = await split({
      root: path.join(root, "apps/web"),
      paths: ["components"],
      measure: false,
      noConfigFile: true,
      config: { minBytesSaved: 0 },
    });
    const card = result.files.find((f) => f.file === "components/Card.tsx");
    expect(card?.status).toBe("split");
    // Badge is a plain component in @acme/ui's source, so the heading stays on the server.
    expect(card?.islands.map((i) => i.rootTag)).toEqual(["button"]);
    expect(card?.outputs["components/Card.tsx"]).toContain('import { Badge } from "@acme/ui";');
  });

  it("judges a linked package by the file that runs, not the one TypeScript reads", async () => {
    const result = await split({
      root: path.join(root, "apps/web"),
      paths: ["components/Price.tsx"],
      measure: false,
      noConfigFile: true,
      config: { minBytesSaved: 0 },
    });
    // dist/index.js starts with "use client", so formatPrice can't be called on the server.
    expect(result.files[0]?.islands.map((i) => i.rootTag)).toEqual(["h2", "button"]);
  });

  it("prefixes a project's results with its path", () => {
    const prefixed = prefixResult(
      {
        file: "components/Card.tsx",
        status: "split",
        islands: [],
        staticRatio: 1,
        requires: ["components/Shelf.tsx"],
        routes: [{ route: "/", load: "initial" }],
        diff: "--- a/components/Card.tsx\n+++ b/components/Card.tsx\n",
        outputs: { "components/Card.tsx": "x" },
      },
      "apps/web",
    );
    expect(prefixed).toMatchObject({
      file: "apps/web/components/Card.tsx",
      requires: ["apps/web/components/Shelf.tsx"],
      routes: [{ route: "apps/web:/", load: "initial" }],
      diff: "--- a/apps/web/components/Card.tsx\n+++ b/apps/web/components/Card.tsx\n",
      outputs: { "apps/web/components/Card.tsx": "x" },
    });
  });
});
