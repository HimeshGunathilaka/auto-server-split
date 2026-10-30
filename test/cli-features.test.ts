import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "dist/cli.js");
const fixture = path.join(repo, "test/fixtures/01-postcard-like-button/input");
const tmpRoot = path.join(repo, "test/.tmp");
let dir = "";

function run(args: string[], cwd = dir, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    // Unset what CI sets: report paths are relative to GITHUB_WORKSPACE / CI_PROJECT_DIR.
    env: {
      ...process.env,
      NO_COLOR: "1",
      GITHUB_STEP_SUMMARY: "",
      GITHUB_WORKSPACE: "",
      CI_PROJECT_DIR: "",
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function freshCopy(into = "") {
  dir = path.join(tmpRoot, `cli-features-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, into), { recursive: true });
  cpSync(fixture, path.join(dir, into), { recursive: true });
}

beforeAll(() => {
  if (!existsSync(cli))
    throw new Error("dist/cli.js missing: run `pnpm build` (pnpm test does this)");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("--explain and --graph", () => {
  it("explains a split: its boundary, why each element is client-only, and its imports", () => {
    freshCopy();
    const r = run(["--explain", "PostCard.tsx", "--no-measure"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('PostCard.tsx  "use client" boundary');
    expect(r.stdout).toContain("rendered by: app/page.tsx:1");
    expect(r.stdout).toContain("<button> (line 15): has onClick, reads setLiked, reads liked");
    expect(r.stdout).toContain("date-fns, marked: leaves the client bundle");
    const json = JSON.parse(run(["--explain", "PostCard.tsx", "--no-measure", "--json"]).stdout);
    expect(json).toMatchObject({
      file: "PostCard.tsx",
      kind: "client-boundary",
      result: { status: "split" },
      components: [{ name: "PostCard", anchors: [{ element: "<button>", line: 15 }] }],
    });
  });

  it("explains a server module and refuses combinations that don't make sense", () => {
    freshCopy();
    expect(run(["--explain", "app/page.tsx"]).stdout).toContain(
      "app/page.tsx  server code: nothing imports it (a route file, or unused)",
    );
    expect(run(["--explain"]).stderr).toContain("--explain needs a file");
    expect(run(["--explain", "app"]).stderr).toContain("app is a directory");
    expect(run(["--explain", "PostCard.tsx", "app/page.tsx"]).stderr).toContain(
      "--explain explains one file",
    );
    expect(run(["--explain", "PostCard.tsx", "--write"]).stderr).toContain(
      "--explain, --graph and --watch don't write or check",
    );
    expect(run(["--explain", "nope.tsx"]).stderr).toContain("nope.tsx does not exist");
    writeFileSync(
      path.join(dir, "Widget.client.tsx"),
      '"use client";\nexport function Widget() {\n  return null;\n}\n',
    );
    const island = run(["--explain", "Widget.client.tsx", "--no-measure"]);
    expect(island.stdout).toContain(
      "treated as a generated island: runs never analyse or change it",
    );
    expect(island.stdout).not.toContain("skipped");
  });

  it("suggests extracting a context provider, and not again from the provider itself", () => {
    freshCopy();
    const shell = `"use client";
import { createContext, useState } from "react";

const ThemeCtx = createContext("light");

export function Shell({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState("light");
  return <ThemeCtx.Provider value={theme}>{children}<button onClick={() => setTheme("dark")}>{theme}</button></ThemeCtx.Provider>;
}
`;
    writeFileSync(path.join(dir, "Shell.tsx"), shell);
    writeFileSync(path.join(dir, "ShellProvider.tsx"), shell.replaceAll("Shell", "ShellProvider"));
    writeFileSync(
      path.join(dir, "app/page.tsx"),
      'import { Shell } from "../Shell";\nimport { ShellProvider } from "../ShellProvider";\n\nexport default function Page() {\n  return <ShellProvider><Shell><p>hi</p></Shell></ShellProvider>;\n}\n',
    );
    expect(run(["--explain", "Shell.tsx", "--no-measure"]).stdout).toContain(
      '(with the state that feeds its value) into a "use client" file of their own (ShellProvider.tsx)',
    );
    expect(run(["--explain", "ShellProvider.tsx", "--no-measure"]).stdout).toContain(
      "this file is the provider, so there's nothing left to extract",
    );
  });

  it("lists the client boundaries", () => {
    freshCopy();
    const r = run(["--graph"]);
    expect(r.stdout).toContain('Client boundaries (1 "use client" file)');
    expect(r.stdout).toContain("rendered by app/page.tsx:1");
    expect(r.stdout).toContain("pulls in packages: date-fns, marked");
    expect(JSON.parse(run(["--graph", "--json"]).stdout)).toEqual({
      boundaries: [
        {
          file: "PostCard.tsx",
          renderedBy: [{ file: "app/page.tsx", line: 1 }],
          clientImporters: [],
          modules: [],
          packages: ["date-fns", "marked"],
        },
      ],
    });
  });
});

describe("report formats", () => {
  it("writes SARIF to a file with --output and still prints the text output", () => {
    freshCopy();
    const r = run([".", "--format", "sarif", "--output", "out.sarif", "--no-measure"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✔ split PostCard.tsx");
    expect(r.stdout).toContain("Wrote the sarif report to out.sarif.");
    const sarif = JSON.parse(readFileSync(path.join(dir, "out.sarif"), "utf8"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("auto-server-split");
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toEqual([
      "split-available",
      "timezone-dependent",
    ]);
    expect(sarif.runs[0].results[0]).toMatchObject({
      level: "note",
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: "PostCard.tsx" },
            region: { startLine: 15 },
          },
        },
      ],
      partialFingerprints: { "autoServerSplit/v1": expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
  });

  it("prints GitLab Code Quality issues and a self-contained HTML report", () => {
    freshCopy();
    const issues = JSON.parse(run([".", "--format", "gitlab", "--no-measure"]).stdout);
    expect(issues[0]).toMatchObject({
      check_name: "split-available",
      severity: "info",
      location: { path: "PostCard.tsx", lines: { begin: 15 } },
    });
    const html = run([".", "--format", "html", "--no-measure"]).stdout;
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<code class="path">PostCard.tsx</code>');
    expect(html).not.toMatch(/<script src|<link /);
    // One block per diff line, nothing between them (a newline there doubled the spacing).
    expect(html).toContain(
      '<span class="l add">+import { PostCardButton } from &quot;./PostCard.client&quot;;</span><span class="l">',
    );
    expect(html).not.toMatch(/<\/span>\n<span class="l/);
    expect(html).toContain("2 files scanned");
    expect(run([".", "--output", "x.txt"]).stderr).toContain("--output needs a report format");
  });

  it("--json includes the summary", () => {
    freshCopy();
    const report = JSON.parse(run([".", "--json", "--no-measure"]).stdout);
    expect(report.summary).toMatchObject({
      useClientFiles: 1,
      changes: 1,
      splits: 1,
      islands: 1,
      skipped: 0,
      warnings: { "timezone-dependent": 1 },
      routes: 1,
    });
    expect(report.routes).toEqual([{ route: "/", files: ["PostCard.tsx"] }]);
    expect(report.files[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("checks --output before writing anything", () => {
    freshCopy();
    const missing = run([".", "--write", "--allow-dirty", "--json", "--output", "nope/r.json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--output nope/r.json: its directory");
    expect(missing.stderr).not.toContain("    at ");
    expect(existsSync(path.join(dir, "PostCard.client.tsx"))).toBe(false);
    expect(run([".", "--json", "--output", "app"]).stderr).toContain(
      "--output app: is a directory",
    );
    expect(run(["--explain", "PostCard.tsx", "--json", "--output", "x.json"]).stderr).toContain(
      "--explain and --graph print to the terminal; drop --output",
    );
    expect(run([".", "--write-baseline", "nope/b.json"]).stderr).toContain(
      "--write-baseline nope/b.json: its directory",
    );
  });

  it("keeps a fingerprint across a move, and gives another component of the same name its own", () => {
    freshCopy();
    const print = (file: string) =>
      JSON.parse(run([".", "--json", "--no-measure"]).stdout).files.find(
        (f: { file: string }) => f.file === file,
      )?.fingerprint;
    const original = print("PostCard.tsx");
    const source = readFileSync(path.join(dir, "PostCard.tsx"), "utf8");
    mkdirSync(path.join(dir, "cards"));
    writeFileSync(
      path.join(dir, "cards/PostCard.tsx"),
      source.replace('"use client";\n', '"use client";\n// Moved here, with a line above.\n'),
    );
    rmSync(path.join(dir, "PostCard.tsx"));
    const page = path.join(dir, "app/page.tsx");
    writeFileSync(page, readFileSync(page, "utf8").replace("../PostCard", "../cards/PostCard"));
    expect(print("cards/PostCard.tsx")).toBe(original);

    // Same component name and island names, different component.
    mkdirSync(path.join(dir, "shop"));
    writeFileSync(
      path.join(dir, "shop/PostCard.tsx"),
      source.replace("<article", '<article id="shop"'),
    );
    writeFileSync(
      page,
      `import PostCard from "../cards/PostCard";\nimport ShopCard from "../shop/PostCard";\n\nexport default function Page() {\n  const post = { title: "Hello", date: "2026-01-01", body: "**Hi** there" };\n  return (\n    <>\n      <PostCard post={post} />\n      <ShopCard post={post} />\n    </>\n  );\n}\n`,
    );
    expect(print("shop/PostCard.tsx")).toMatch(/^[0-9a-f]{16}$/);
    expect(print("shop/PostCard.tsx")).not.toBe(original);
  });
});

describe("--check budgets", () => {
  it("fails only for changes above minSaving, or when maxRecoverable is exceeded", () => {
    freshCopy();
    writeFileSync(
      path.join(dir, "auto-split.config.json"),
      JSON.stringify({ minBytesSaved: 0, check: { minSaving: 1_000_000 } }),
    );
    const within = run([".", "--check"]);
    expect(within.code).toBe(0);
    expect(within.stdout).toContain("within the configured check thresholds");
    writeFileSync(
      path.join(dir, "auto-split.config.json"),
      JSON.stringify({ minBytesSaved: 0, check: { maxRecoverable: 100 } }),
    );
    const over = run([".", "--check"]);
    expect(over.code).toBe(2);
    expect(over.stdout).toMatch(
      /✗ the available changes save [\d.]+ KB, more than maxRecoverable \(100 B\)/,
    );
  });

  it("counts new boundaries against a baseline", () => {
    freshCopy();
    writeFileSync(
      path.join(dir, "auto-split.config.json"),
      JSON.stringify({ check: { maxNewBoundaries: 0 } }),
    );
    writeFileSync(
      path.join(dir, "base.json"),
      JSON.stringify({ version: 2, files: [], entries: [], boundaries: ["Other.tsx"] }),
    );
    const r = run([".", "--check", "--no-measure", "--baseline", "base.json"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(
      '✗ 1 "use client" file isn\'t in the baseline (maxNewBoundaries is 0): PostCard.tsx',
    );
    // A report format keeps stdout for the report; the reason goes to stderr.
    const json = run([".", "--check", "--json", "--no-measure", "--baseline", "base.json"]);
    expect(json.code).toBe(2);
    expect(json.stderr).toContain('✗ 1 "use client" file isn\'t in the baseline');
  });

  it("needs a baseline with boundaries, and doesn't count moved or renamed files", () => {
    freshCopy();
    const config = path.join(dir, "auto-split.config.json");
    writeFileSync(config, JSON.stringify({ check: { maxNewBoundaries: 0 } }));
    expect(run([".", "--check", "--no-measure"]).stderr).toContain(
      'check.maxNewBoundaries compares "use client" files with a baseline',
    );
    writeFileSync(path.join(dir, "v1.json"), JSON.stringify({ files: ["PostCard.tsx"] }));
    const v1 = run([".", "--check", "--no-measure", "--baseline", "v1.json"]);
    expect(v1.code).toBe(1);
    expect(v1.stderr).toContain("was written by an older version");

    // A skipped boundary (no fingerprint) next to the split one.
    writeFileSync(
      path.join(dir, "Counter.tsx"),
      '"use client";\nimport { useState } from "react";\n\nexport function Counter() {\n  const [n, setN] = useState(0);\n  return <button onClick={() => setN(n + 1)}>{n}</button>;\n}\n',
    );
    const page = path.join(dir, "app/page.tsx");
    writeFileSync(
      page,
      readFileSync(page, "utf8")
        .replace(
          'import PostCard from "../PostCard";',
          'import PostCard from "../PostCard";\nimport { Counter } from "../Counter";',
        )
        .replace("return <PostCard", "return <><Counter /><PostCard")
        .replace("/>;", "/></>;"),
    );
    expect(run([".", "--write-baseline", "base.json", "--no-measure"]).code).toBe(0);
    const check = () => run([".", "--check", "--no-measure", "--baseline", "base.json"]);
    expect(check().code).toBe(0);

    // PostCard moves (its change's fingerprint matches); Counter is renamed (its code matches).
    mkdirSync(path.join(dir, "cards"));
    writeFileSync(
      path.join(dir, "cards/PostCard.tsx"),
      readFileSync(path.join(dir, "PostCard.tsx"), "utf8"),
    );
    rmSync(path.join(dir, "PostCard.tsx"));
    writeFileSync(path.join(dir, "Clicker.tsx"), readFileSync(path.join(dir, "Counter.tsx")));
    rmSync(path.join(dir, "Counter.tsx"));
    writeFileSync(
      page,
      readFileSync(page, "utf8")
        .replace("../PostCard", "../cards/PostCard")
        .replace("../Counter", "../Clicker"),
    );
    const moved = check();
    expect(moved.stdout).not.toContain("isn't in the baseline");
    expect(moved.code).toBe(0);
    // Baselined, so no alert either.
    const sarif = JSON.parse(
      run([".", "--format", "sarif", "--no-measure", "--baseline", "base.json"]).stdout,
    );
    expect(JSON.stringify(sarif.runs[0].results)).not.toContain("PostCard");

    // A new boundary still counts.
    writeFileSync(
      path.join(dir, "Other.tsx"),
      readFileSync(path.join(dir, "Clicker.tsx"), "utf8").replace("Counter", "Other"),
    );
    writeFileSync(
      page,
      readFileSync(page, "utf8")
        .replace(
          'import { Counter } from "../Clicker";',
          'import { Counter } from "../Clicker";\nimport { Other } from "../Other";',
        )
        .replace("<Counter />", "<Counter /><Other />"),
    );
    const added = check();
    expect(added.code).toBe(2);
    expect(added.stdout).toContain("(maxNewBoundaries is 0): Other.tsx");
  });
});

describe("compare and verify", () => {
  it("compares two reports", () => {
    freshCopy();
    const before = run([".", "--json", "--no-measure"]).stdout;
    writeFileSync(path.join(dir, "before.json"), before);
    expect(run([".", "--write", "--allow-dirty", "--no-measure"]).code).toBe(0);
    writeFileSync(path.join(dir, "after.json"), run([".", "--json", "--no-measure"]).stdout);
    const r = run(["compare", "before.json", "after.json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("changes available: 1 → 0");
    expect(r.stdout).toContain("No longer available:");
    expect(r.stdout).toContain("PostCard.tsx (applied or removed)");
    expect(run(["compare", "after.json", "before.json", "--fail-on-new"]).code).toBe(2);
    const json = JSON.parse(
      run(["compare", "before.json", "after.json", "--format", "json"]).stdout,
    );
    expect(json.resolved).toEqual([{ file: "PostCard.tsx", status: "split" }]);
  });

  it("runs the configured verification commands and stops at the first failure", () => {
    freshCopy();
    writeFileSync(
      path.join(dir, "auto-split.config.json"),
      JSON.stringify({
        verify: {
          commands: [
            'node -e "console.log(1)"',
            'node -e "process.exit(3)"',
            'node -e "console.log(2)"',
          ],
        },
      }),
    );
    writeFileSync(path.join(dir, "report.json"), run([".", "--json", "--no-measure"]).stdout);
    const r = run(["verify", "--report", "report.json"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✔ node -e "console.log(1)"');
    expect(r.stdout).toContain('✗ exited with 3: node -e "process.exit(3)"');
    expect(r.stdout).toContain('– not run: node -e "console.log(2)"');
    // The output is still shown, and the report keeps its tail.
    expect(r.stdout).toMatch(/▶ node -e "console.log\(1\)"\n1\n/);
    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8"));
    expect(report.verification).toMatchObject({
      passed: false,
      notRun: ['node -e "console.log(2)"'],
      steps: [{ outputTail: "1" }, { exitCode: 3 }],
    });
    const json = JSON.parse(run(["verify", "--json", "--keep-going"]).stdout);
    expect(json.steps.map((s: { exitCode: number }) => s.exitCode)).toEqual([0, 3, 0]);
    expect(json.steps[0].outputTail).toBe("1");
  });

  it("checks --report before running any command", () => {
    freshCopy();
    writeFileSync(
      path.join(dir, "auto-split.config.json"),
      JSON.stringify({
        verify: { commands: ["node -e \"require('fs').writeFileSync('ran', '')\""] },
      }),
    );
    expect(run(["verify", "--report", "missing.json"]).stderr).toContain("can't read missing.json");
    writeFileSync(path.join(dir, "base.json"), JSON.stringify({ files: ["PostCard.tsx"] }));
    expect(run(["verify", "--report", "base.json"]).stderr).toContain(
      "not an auto-server-split JSON report",
    );
    expect(existsSync(path.join(dir, "ran"))).toBe(false);
    expect(run(["verify"]).code).toBe(0);
    expect(existsSync(path.join(dir, "ran"))).toBe(true);
  });
});

describe("workspaces", () => {
  it("runs on the workspace's Next.js apps and reports paths from its root", () => {
    freshCopy("apps/web");
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "repo", private: true, workspaces: ["apps/*"] }),
    );
    writeFileSync(
      path.join(dir, "apps/web/package.json"),
      JSON.stringify({ name: "web", dependencies: { next: "*" } }),
    );
    writeFileSync(
      path.join(dir, "apps/web/auto-split.config.json"),
      JSON.stringify({ include: ["*.tsx", "app/**"] }),
    );
    const r = run(["--workspace", "--no-measure"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("▸ apps/web");
    expect(r.stdout).toContain("✔ split apps/web/PostCard.tsx");
    const json = JSON.parse(run(["--project", "apps/web", "--no-measure", "--json"]).stdout);
    expect(json.files[0]).toMatchObject({
      file: "apps/web/PostCard.tsx",
      routes: [{ route: "apps/web:/", load: "initial" }],
    });
    expect(Object.keys(json.files[0].outputs)).toEqual([
      "apps/web/PostCard.tsx",
      "apps/web/PostCard.client.tsx",
    ]);
    expect(run(["--workspace", "--explain", "apps/web/PostCard.tsx"]).stderr).toContain(
      "--explain, --graph, --watch and --interactive need one",
    );
  });
});

describe("--watch", () => {
  function startWatch() {
    const child = spawn(process.execPath, [cli, ".", "--watch", "--no-measure"], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const state = { out: "" };
    child.stdout.on("data", (d) => (state.out += d));
    child.stderr.on("data", (d) => (state.out += d));
    const waitFor = async (text: string, from = 0) => {
      for (let i = 0; i < 200 && !state.out.slice(from).includes(text); i++)
        await new Promise((r) => setTimeout(r, 100));
      return state.out.slice(from).includes(text);
    };
    return { child, state, waitFor };
  }

  it("re-analyses once per change with a TypeScript config, and reloads an edited .mjs config", async () => {
    freshCopy();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      path.join(dir, "auto-split.config.ts"),
      'import { defineConfig } from "auto-server-split";\nexport default defineConfig({ minBytesSaved: 0 });\n',
    );
    const ts = startWatch();
    try {
      expect(await ts.waitFor("watching for changes")).toBe(true);
      const mark = ts.state.out.length;
      writeFileSync(path.join(dir, "PostCard.tsx"), readFileSync(path.join(dir, "PostCard.tsx")));
      expect(await ts.waitFor("watching for changes", mark)).toBe(true);
      // Each run compiles the config to a temporary file next to it; that must not trigger a run.
      await new Promise((r) => setTimeout(r, 1500));
      expect(ts.state.out.slice(mark).match(/re-analysed in/g)).toHaveLength(1);
    } finally {
      ts.child.kill("SIGINT");
    }

    rmSync(path.join(dir, "auto-split.config.ts"));
    const config = path.join(dir, "auto-split.config.mjs");
    writeFileSync(config, "export default { minBytesSaved: 0 };\n");
    const mjs = startWatch();
    try {
      expect(await mjs.waitFor("1 change available")).toBe(true);
      const mark = mjs.state.out.length;
      writeFileSync(config, "export default { exclude: ['PostCard.tsx'] };\n");
      expect(await mjs.waitFor("0 changes available", mark)).toBe(true);
    } finally {
      mjs.child.kill("SIGINT");
    }
  });

  it("re-analyses a changed file and prints what changed", async () => {
    freshCopy();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const { child, state, waitFor } = startWatch();
    try {
      expect(await waitFor("watching for changes")).toBe(true);
      expect(state.out).toContain("✔ split PostCard.tsx");
      const mark = state.out.length;
      const file = path.join(dir, "PostCard.tsx");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          'import { useState } from "react";',
          'import { createContext, useState } from "react";\nconst Ctx = createContext(0);',
        ),
      );
      expect(await waitFor("watching for changes", mark)).toBe(true);
      expect(state.out.slice(mark)).toContain("re-analysed in");
      expect(state.out.slice(mark)).toContain("– skipped PostCard.tsx");
      expect(state.out.slice(mark)).toContain("[context-provider]");
    } finally {
      child.kill("SIGINT");
    }
  });
});
