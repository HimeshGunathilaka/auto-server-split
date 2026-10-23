import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "dist/cli.js");
const fixture = path.join(repo, "test/fixtures/01-postcard-like-button/input");
const tmpRoot = path.join(repo, "test/.tmp");
let dir = "";

function run(args: string[], cwd = dir) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function freshCopy(git: boolean, from = fixture) {
  dir = path.join(tmpRoot, `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cpSync(from, dir, { recursive: true });
  if (git) {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    g("init", "-q");
    g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  }
}

beforeAll(() => {
  if (!existsSync(cli))
    throw new Error("dist/cli.js missing: run `pnpm build` (pnpm test does this)");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CLI", () => {
  it("dry-run (default) prints the diff and writes nothing", () => {
    freshCopy(false);
    const r = run(["PostCard.tsx"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✔ split PostCard.tsx");
    expect(r.stdout).toContain("+export function PostCardButton()");
    expect(r.stdout).toContain("estimated saving");
    expect(existsSync(path.join(dir, "PostCard.client.tsx"))).toBe(false);
  });

  it("--check exits 2 when a split is available and 0 when not", () => {
    freshCopy(false);
    expect(run(["PostCard.tsx", "--check"]).code).toBe(2);
    expect(run(["app/page.tsx", "--check"]).code).toBe(0);
  });

  it("--remove-unused-directives removes a directive, and the next pass splits what it imports", () => {
    freshCopy(false, path.join(repo, "test/fixtures/35-remove-unused-directive/input"));
    const r = run([".", "--remove-unused-directives", "--no-measure"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      '✔ removed "use client" components/Sidebar.tsx · no client-only code',
    );
    expect(r.stdout).toContain("✔ split components/PostCard.tsx");
    expect(r.stdout).toContain("files split:    1 (dry run, nothing written)");
    expect(r.stdout).toContain("directives removed: 1 (dry run, nothing written)");
    expect(run([".", "--check", "--no-measure"]).code).toBe(0);
    expect(run([".", "--check", "--no-measure", "--remove-unused-directives"]).code).toBe(2);
  });

  it("--json prints the API result shape", () => {
    freshCopy(false);
    const r = run(["PostCard.tsx", "--json", "--no-measure"]);
    const report = JSON.parse(r.stdout) as {
      files: { file: string; status: string; outputs: Record<string, string> }[];
    };
    expect(report.files[0]).toMatchObject({ file: "PostCard.tsx", status: "split" });
    expect(Object.keys(report.files[0]?.outputs ?? {})).toEqual([
      "PostCard.tsx",
      "PostCard.client.tsx",
    ]);
  });

  it("--write refuses files git can't restore (here: ignored) unless --allow-dirty", () => {
    // test/.tmp is inside this repository and git-ignored.
    freshCopy(false);
    const refused = run(["PostCard.tsx", "--write"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("PostCard.tsx (ignored by git)");
    expect(existsSync(path.join(dir, "PostCard.client.tsx"))).toBe(false);
    expect(run(["PostCard.tsx", "--write", "--allow-dirty"]).code).toBe(0);
    expect(existsSync(path.join(dir, "PostCard.client.tsx"))).toBe(true);
  });

  it("--write refuses when the target file has uncommitted changes", () => {
    freshCopy(true);
    writeFileSync(
      path.join(dir, "PostCard.tsx"),
      `${readFileSync(path.join(dir, "PostCard.tsx"), "utf8")}\n// edit\n`,
    );
    const r = run(["PostCard.tsx", "--write"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("uncommitted changes");
  });

  it("--write applies the split on a clean git tree", () => {
    freshCopy(true);
    const r = run(["PostCard.tsx", "--write"]);
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(dir, "PostCard.client.tsx"), "utf8")).toContain(
      "export function PostCardButton()",
    );
    expect(readFileSync(path.join(dir, "PostCard.tsx"), "utf8")).not.toContain('"use client"');
  });

  it("rejects an invalid config file with a clear error", () => {
    freshCopy(false);
    writeFileSync(
      path.join(dir, "auto-split.config.json"),
      JSON.stringify({ minBytesSaved: -1, colour: "red" }),
    );
    const r = run(["PostCard.tsx"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown key "colour"');
    expect(r.stderr).toContain('"minBytesSaved" must be a non-negative number');
  });

  it("--interactive refuses --dry-run, --json and --check, and writes nothing", () => {
    freshCopy(true);
    for (const flag of ["--dry-run", "--json", "--check"]) {
      const r = run(["PostCard.tsx", "--interactive", flag, "--no-measure"]);
      expect(r.code).toBe(1);
      // Rejected for the combination, before it even asks for a terminal.
      expect(r.stderr).toContain(
        "--interactive can't be combined with --dry-run, --json or --check",
      );
    }
    expect(existsSync(path.join(dir, "PostCard.client.tsx"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });

  it("--interactive alone still needs a terminal", () => {
    freshCopy(true);
    const r = run(["PostCard.tsx", "--interactive", "--no-measure"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--interactive needs a terminal");
  });

  it("skips a split whose saving can't be measured, unless minBytesSaved is 0", () => {
    freshCopy(false);
    const source = readFileSync(path.join(dir, "PostCard.tsx"), "utf8");
    writeFileSync(
      path.join(dir, "PostCard.tsx"),
      source
        .replace('import { useState } from "react";', '$&\nimport { fmt } from "virtual-fmt";')
        .replace("<h2>{post.title}</h2>", "<h2>{fmt(post.title)}</h2>"),
    );
    writeFileSync(
      path.join(dir, "virtual.d.ts"),
      'declare module "virtual-fmt" { export function fmt(s: string): string; }\n',
    );
    const skipped = run(["PostCard.tsx"]);
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).toContain("[measure-failed]");
    expect(skipped.stdout).toContain('Could not resolve "virtual-fmt"');
    expect(run(["PostCard.tsx", "--check"]).code).toBe(0);

    writeFileSync(path.join(dir, "auto-split.config.json"), JSON.stringify({ minBytesSaved: 0 }));
    const split = run(["PostCard.tsx"]);
    expect(split.stdout).toContain("✔ split PostCard.tsx");
    expect(split.stdout).toContain("saving not measured (esbuild: PostCard.tsx:");
    expect(split.stdout).toContain("(1 split not measured)");
    expect(run(["PostCard.tsx", "--check"]).code).toBe(2);
  });

  it("doesn't scan the island files it generated", () => {
    freshCopy(false);
    expect(run([".", "--write", "--allow-dirty", "--no-measure"]).code).toBe(0);
    expect(existsSync(path.join(dir, "PostCard.client.tsx"))).toBe(true);
    const again = run([".", "--no-measure"]);
    expect(again.stdout).not.toContain("PostCard.client.tsx");
    expect(again.stdout).toContain('files scanned:  2 (0 with "use client")');
    expect(again.stdout).toContain("files skipped:  0");
  });

  it("exits 1 for a path that does not exist", () => {
    freshCopy(false);
    expect(run(["nope.tsx"]).code).toBe(1);
  });
});
