import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "dist/cli.js");
const fixture = path.join(repo, "fixtures/01-postcard-like-button/input");
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

function freshCopy(git: boolean) {
  dir = path.join(tmpRoot, `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, { recursive: true });
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

  it("exits 1 for a path that does not exist", () => {
    freshCopy(false);
    expect(run(["nope.tsx"]).code).toBe(1);
  });
});
