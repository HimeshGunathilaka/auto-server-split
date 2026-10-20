import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, describe, expect, it } from "vitest";
import { clearLintCache } from "../src/eslint/engine.js";
import plugin from "../src/eslint/index.js";
import { split } from "../src/index.js";

/**
 * The rule must report exactly the files the CLI would split, under the same config (any config
 * format) and the same thresholds. Each scenario is linted with and without typed linting and
 * compared with `split()` (measurement on, as in the CLI).
 */

const TMP = path.resolve(import.meta.dirname, ".tmp");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  clearLintCache();
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
  exclude: ["auto-split.config.*"],
});

// Saves ~50 B gzip: under the default minBytesSaved (2 KB).
const CARD = `"use client";
import { useState } from "react";

export default function Card({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2>{title}</h2>
      <p>Some static text</p>
      <p>More static text</p>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`;

// date-fns and marked leave the client bundle: well over 2 KB.
const POST_CARD = `"use client";
import { format } from "date-fns";
import { marked } from "marked";
import { useState } from "react";

type Post = { title: string; date: string; body: string };

export default function PostCard({ post }: { post: Post }) {
  const [liked, setLiked] = useState(false);
  return (
    <article>
      <h2>{post.title}</h2>
      <time>{format(new Date(post.date), "PPP")}</time>
      <div dangerouslySetInnerHTML={{ __html: marked(post.body) as string }} />
      <p>Static footer</p>
      <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>
    </article>
  );
}
`;

// TypeScript resolves "virtual-fmt"; esbuild can't bundle it, so the saving can't be measured.
const UNMEASURABLE = `"use client";
import { useState } from "react";
import { fmt } from "virtual-fmt";
import { format } from "date-fns";

export default function Unmeasurable({ title }: { title: string }) {
  const [n, setN] = useState(0);
  return (
    <section>
      <h2>{fmt(title)}</h2>
      <time>{format(new Date(0), "PPP")}</time>
      <p>Static</p>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`;

// The island takes no props, so an untyped file can split.
const TOGGLE_JSX = `"use client";
import { marked } from "marked";
import { useState } from "react";

export default function Toggle() {
  const [on, setOn] = useState(false);
  return (
    <section>
      <div dangerouslySetInnerHTML={{ __html: marked("# Title") }} />
      <p>Static</p>
      <button onClick={() => setOn(!on)}>{on ? "on" : "off"}</button>
    </section>
  );
}
`;

const PAGE = `import Card from "../components/Card";
import PostCard from "../components/PostCard";
import Unmeasurable from "../components/Unmeasurable";

export default function Page() {
  return (
    <main>
      <Card title="t" />
      <PostCard post={{ title: "t", date: "2026-01-01", body: "b" }} />
      <Unmeasurable title="u" />
    </main>
  );
}
`;

const BASE_FILES = {
  "tsconfig.json": TSCONFIG,
  "virtual.d.ts": `declare module "virtual-fmt" { export function fmt(s: string): string; }\n`,
  "components/Card.tsx": CARD,
  "components/PostCard.tsx": POST_CARD,
  "components/Unmeasurable.tsx": UNMEASURABLE,
  "app/page.tsx": PAGE,
};

type Scenario = {
  name: string;
  files?: Record<string, string>;
  /** Files the CLI is expected to split (guards the scenario itself). */
  expectSplit: string[];
};

const SCENARIOS: Scenario[] = [
  { name: "no config: thresholds from the defaults", expectSplit: ["components/PostCard.tsx"] },
  {
    name: "json config raises minStaticRatio above every file",
    files: { "auto-split.config.json": JSON.stringify({ minStaticRatio: 0.95 }) },
    expectSplit: [],
  },
  {
    name: "ts config raises minStaticRatio (defineConfig)",
    files: {
      "auto-split.config.ts": `import { defineConfig } from "auto-server-split";\nexport default defineConfig({ minStaticRatio: 0.95 });\n`,
    },
    expectSplit: [],
  },
  {
    name: "mjs config sets minBytesSaved to 0",
    files: { "auto-split.config.mjs": `export default { minBytesSaved: 0 };\n` },
    expectSplit: ["components/Card.tsx", "components/PostCard.tsx", "components/Unmeasurable.tsx"],
  },
  {
    name: "ts config marks date-fns client-only (changes the islands)",
    files: {
      "auto-split.config.ts": `export default { clientOnlyPackages: ["date-fns"], minBytesSaved: 0 };\n`,
    },
    expectSplit: ["components/Card.tsx", "components/PostCard.tsx", "components/Unmeasurable.tsx"],
  },
  {
    // In the program only through an import (allowJs), like a Next.js app whose tsconfig includes
    // just **/*.ts(x): the lazy (untyped) graph has to follow imports as TypeScript does.
    name: "a .jsx component outside the tsconfig include, imported from a page",
    files: {
      "tsconfig.json": TSCONFIG.replace('"strict":true', '"strict":true,"allowJs":true'),
      "components/Toggle.jsx": TOGGLE_JSX,
      // Toggle and PostCard both import marked, so neither one's conservative saving counts it.
      "auto-split.config.json": JSON.stringify({ minBytesSaved: 0 }),
      "app/page.tsx": `import Toggle from "../components/Toggle";\n${PAGE.replace("<main>", "<main>\n      <Toggle />")}`,
    },
    expectSplit: [
      "components/Card.tsx",
      "components/PostCard.tsx",
      "components/Toggle.jsx",
      "components/Unmeasurable.tsx",
    ],
  },
  {
    name: "js config with a clientFileSuffix whose output already exists",
    files: {
      "auto-split.config.js": `export default { clientFileSuffix: ".island", minBytesSaved: 0 };\n`,
      "components/PostCard.island.tsx": `export const taken = true;\n`,
    },
    expectSplit: ["components/Card.tsx", "components/Unmeasurable.tsx"],
  },
];

type Report = { islands: number; ratio: number };

function makeProject(extra: Record<string, string> = {}): string {
  const root = path.join(TMP, `parity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(root);
  for (const [rel, content] of Object.entries({ ...BASE_FILES, ...extra })) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

async function cliSplits(root: string): Promise<Map<string, Report>> {
  const { files } = await split({ root, paths: ["components"] });
  for (const f of files)
    if (f.skipped?.code === "internal-error") throw new Error(f.skipped.message);
  return new Map(
    files
      .filter((f) => f.status === "split")
      .map((f) => [f.file, { islands: f.islands.length, ratio: Math.round(f.staticRatio * 100) }]),
  );
}

async function lintReports(
  root: string,
  typed: boolean,
  options: Record<string, unknown>,
): Promise<Map<string, Report>> {
  clearLintCache();
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.tsx", "**/*.jsx"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            ecmaFeatures: { jsx: true },
            ...(typed ? { projectService: true, tsconfigRootDir: root } : {}),
          },
        },
        plugins: { "auto-server-split": plugin },
        rules: { "auto-server-split/prefer-server-split": ["warn", options] },
      },
    ],
  });
  const results = await eslint.lintFiles(["components/*.{tsx,jsx}"]);
  const out = new Map<string, Report>();
  for (const r of results) {
    const fatal = r.messages.find((m) => m.fatal || !m.ruleId);
    if (fatal) throw new Error(`${r.filePath}: ${fatal.message}`);
    for (const m of r.messages) {
      const match = /is (\d+)% static with (\d+) interactive island/.exec(m.message);
      if (!match) throw new Error(`unexpected message: ${m.message}`);
      out.set(path.relative(root, r.filePath).split(path.sep).join("/"), {
        ratio: Number(match[1]),
        islands: Number(match[2]),
      });
    }
  }
  return out;
}

describe("prefer-server-split reports exactly what the CLI splits", () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      const root = makeProject(scenario.files);
      let cli: Map<string, Report>;

      it("CLI splits the expected files", async () => {
        cli = await cliSplits(root);
        expect([...cli.keys()].sort()).toEqual([...scenario.expectSplit].sort());
      });

      for (const typed of [false, true]) {
        const mode = typed ? "typed" : "untyped";

        it(`${mode} lint with minStaticRatio 0 matches the CLI file for file`, async () => {
          const lint = await lintReports(root, typed, { minStaticRatio: 0 });
          expect(Object.fromEntries(lint)).toEqual(Object.fromEntries(cli));
        });

        it(`${mode} lint with default options reports a subset of the CLI's splits`, async () => {
          const lint = await lintReports(root, typed, {});
          for (const [file, report] of lint) {
            expect(cli.get(file)).toEqual(report);
            expect(report.ratio).toBeGreaterThanOrEqual(50);
          }
        });
      }
    });
  }
});
