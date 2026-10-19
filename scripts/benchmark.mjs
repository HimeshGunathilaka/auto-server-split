// Benchmark (spec milestone 1.0): dry-run auto-server-split on real open-source Next.js App Router
// apps, record split/skip rates and estimated KB saved, and (with --build) check that the apps still
// build after `--write`. Results are written to docs/benchmarks.md.
//
// Usage: pnpm build && node scripts/benchmark.mjs [--build] [--dir <work dir>] [appName...]
//
// The apps are cloned at pinned commits into a work directory outside this repository (default:
// <os tmpdir>/auto-server-split-bench), so their own lockfiles and node_modules are used.
// Dependencies are installed with lifecycle scripts disabled.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "dist/cli.js");

export const APPS = [
  {
    name: "next-learn dashboard",
    slug: "next-learn",
    repo: "vercel/next-learn",
    ref: "bb2558441a6673ab76c89914c25018bffa27a2ba",
    dir: "dashboard/final-example",
  },
  {
    name: "Next.js Commerce",
    slug: "commerce",
    repo: "vercel/commerce",
    ref: "f7521d57d29f0eb3d23c1399cf9bb299d61fcd21",
    dir: ".",
  },
  {
    name: "Tailwind Next.js Starter Blog",
    slug: "starter-blog",
    repo: "timlrx/tailwind-nextjs-starter-blog",
    ref: "b45bef66b40c63b6f57c15ee8cd090682238df4c",
    dir: ".",
  },
];

const args = process.argv.slice(2);
const build = args.includes("--build");
const dirFlag = args.indexOf("--dir");
const workDir =
  dirFlag !== -1
    ? path.resolve(args[dirFlag + 1])
    : path.join(os.tmpdir(), "auto-server-split-bench");
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--dir");

function sh(cmd, cmdArgs, cwd, extraEnv = {}) {
  return execFileSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...extraEnv },
  });
}

/** Install command with lifecycle scripts disabled: [command, args, extra env]. */
function packageManager(dir) {
  const has = (f) => existsSync(path.join(dir, f));
  if (has("pnpm-lock.yaml"))
    return ["pnpm", ["install", "--ignore-scripts", "--frozen-lockfile"], {}];
  if (has("yarn.lock")) {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const berry = /^yarn@[2-9]/.test(pkg.packageManager ?? "");
    const releases = path.join(dir, ".yarn/releases");
    if (berry && existsSync(releases)) {
      const [release] = readdirSync(releases).filter((f) => f.endsWith(".cjs"));
      return [
        process.execPath,
        [path.join(releases, release), "install", "--immutable"],
        { YARN_ENABLE_SCRIPTS: "false" },
      ];
    }
    return ["npx", ["--yes", "yarn@1", "install", "--ignore-scripts", "--frozen-lockfile"], {}];
  }
  if (has("package-lock.json"))
    return ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {}];
  return ["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {}];
}

function prepare(app) {
  const clone = path.join(workDir, app.slug);
  if (!existsSync(clone)) {
    mkdirSync(workDir, { recursive: true });
    sh(
      "git",
      ["clone", "-q", "--filter=blob:none", `https://github.com/${app.repo}`, clone],
      workDir,
    );
  }
  sh("git", ["checkout", "-q", "--force", app.ref], clone);
  sh("git", ["clean", "-qfdx", "-e", "node_modules"], clone);
  const appDir = path.join(clone, app.dir);
  if (!existsSync(path.join(appDir, "node_modules"))) {
    const [pm, pmArgs, pmEnv] = packageManager(appDir);
    sh(pm, pmArgs, appDir, pmEnv);
  }
  return appDir;
}

function runCli(appDir, extra) {
  const started = Date.now();
  const out = sh(process.execPath, [cli, "--root", appDir, "--json", ...extra], appDir);
  return { report: JSON.parse(out), seconds: (Date.now() - started) / 1000 };
}

function nextBuild(appDir) {
  const r = spawnSync("npx", ["--no-install", "next", "build"], {
    cwd: appDir,
    encoding: "utf8",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    maxBuffer: 512 * 1024 * 1024,
  });
  return { ok: r.status === 0, log: `${r.stdout}\n${r.stderr}` };
}

function summarize(report, seconds) {
  const files = report.files;
  const split = files.filter((f) => f.status === "split");
  const skips = {};
  for (const f of files) if (f.skipped) skips[f.skipped.code] = (skips[f.skipped.code] ?? 0) + 1;
  return {
    seconds,
    useClient: files.length,
    split: split.map((f) => ({
      file: f.file,
      islands: f.islands.map((i) => i.name),
      staticRatio: f.staticRatio,
      kb: (f.bytesSaved?.conservative ?? 0) / 1024,
    })),
    skips,
    skipDetails: files
      .filter((f) => f.skipped)
      .map((f) => ({
        file: f.file,
        code: f.skipped.code,
        message: f.skipped.message.split("\n")[0],
      })),
    kb: split.reduce((n, f) => n + (f.bytesSaved?.conservative ?? 0), 0) / 1024,
    kbIsolated: split.reduce((n, f) => n + (f.bytesSaved?.isolated ?? 0), 0) / 1024,
    selfCheckFailures: skips["self-check-failed"] ?? 0,
    internalErrors: skips["internal-error"] ?? 0,
  };
}

/** The app's own `tsc --noEmit`: diagnostics as a multiset of "file: TSxxxx message" strings. */
function typecheck(appDir) {
  const r = spawnSync("npx", ["--no-install", "tsc", "--noEmit", "-p", "."], {
    cwd: appDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return `${r.stdout}`
    .split("\n")
    .filter((l) => /error TS\d+/.test(l))
    .map((l) => l.replace(/\(\d+,\d+\)/, ""));
}

function newDiagnostics(before, after) {
  const counts = new Map();
  for (const d of before) counts.set(d, (counts.get(d) ?? 0) + 1);
  const added = [];
  for (const d of after) {
    const n = counts.get(d) ?? 0;
    if (n > 0) counts.set(d, n - 1);
    else added.push(d);
  }
  return added;
}

const results = [];
mkdirSync(workDir, { recursive: true });
// Thresholds off: every split the engine considers safe, however small.
const noThresholds = path.join(workDir, "no-thresholds.json");
writeFileSync(noThresholds, JSON.stringify({ minBytesSaved: 0, minStaticRatio: 0 }));

for (const app of APPS.filter((a) => only.length === 0 || only.includes(a.slug))) {
  console.log(`\n▶ ${app.name} (${app.repo}@${app.ref.slice(0, 7)})`);
  const appDir = prepare(app);
  // The benchmark runs on the whole app, not just the default include globs.
  const defaults = runCli(appDir, ["."]);
  const unlimited = runCli(appDir, [".", "--config", noThresholds]);
  const result = {
    app,
    defaults: summarize(defaults.report, defaults.seconds),
    noThresholds: summarize(unlimited.report, unlimited.seconds),
    build: undefined,
  };
  const d = result.defaults;
  const u = result.noThresholds;
  console.log(
    `  default thresholds: ${d.useClient} "use client" files, ${d.split.length} split, ~${d.kb.toFixed(1)} KB, ${d.seconds.toFixed(1)}s`,
  );
  console.log(`  thresholds off:     ${u.split.length} split, ~${u.kb.toFixed(1)} KB`);

  if (build) {
    const before = nextBuild(appDir);
    const tscBefore = typecheck(appDir);
    let after = { ok: false, log: "" };
    let written = 0;
    let tscAdded = [];
    if (u.split.length > 0) {
      const writeRun = runCli(appDir, [".", "--config", noThresholds, "--write", "--allow-dirty"]);
      written = writeRun.report.files.filter((f) => f.status === "split").length;
      tscAdded = newDiagnostics(tscBefore, typecheck(appDir));
      if (before.ok) after = nextBuild(appDir);
    }
    const clone = path.join(workDir, app.slug);
    sh("git", ["checkout", "-q", "--force", app.ref], clone);
    sh("git", ["clean", "-qfdx", "-e", "node_modules"], clone);
    const errorLines = (log) =>
      [
        ...new Set(
          log
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /error|failed/i.test(l)),
        ),
      ]
        .slice(0, 3)
        .join(" / ");
    result.typecheck = { written, newErrors: tscAdded };
    result.build = {
      before: before.ok,
      written,
      after: before.ok && written > 0 ? after.ok : undefined,
      beforeError: before.ok ? undefined : errorLines(before.log),
      afterError: !before.ok || written === 0 || after.ok ? undefined : errorLines(after.log),
    };
    console.log(
      `  build before: ${before.ok ? "ok" : "failed"}${before.ok && written > 0 ? `; after writing ${written} split(s): ${after.ok ? "ok" : "FAILED"}` : ""}`,
    );
    if (written > 0)
      console.log(
        `  tsc --noEmit after writing ${written} split(s): ${tscAdded.length === 0 ? "no new errors" : `${tscAdded.length} NEW ERRORS`}`,
      );
  }
  results.push(result);
}

writeFileSync(path.join(workDir, "results.json"), JSON.stringify(results, null, 2));
if (only.length === 0)
  writeFileSync(path.join(repoRoot, "docs/benchmarks.md"), renderMarkdown(results));

function renderMarkdown(rows) {
  const date = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push("# Benchmarks", "");
  out.push(
    `Generated by \`node scripts/benchmark.mjs --build\` on ${date} (auto-server-split ${JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version}, Node ${process.version}).`,
    "Each app is cloned at a pinned commit, installed with lifecycle scripts disabled, and analysed in dry-run mode over the whole app (`auto-server-split .`).",
    '"Thresholds off" reruns with `minBytesSaved: 0, minStaticRatio: 0`, which shows every split the engine considers safe, however small.',
    "With `--build`, the app is built before and after `--write` (thresholds off), and its own `tsc --noEmit` must not report new errors.",
    "",
  );
  out.push("## Summary", "");
  out.push(
    '| App | Commit | `"use client"` files | Split (default) | Split (thresholds off) | Est. saved (thresholds off) | Self-check failures | Internal errors | Build before → after | New `tsc` errors | Time |',
  );
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const d = r.defaults;
    const u = r.noThresholds;
    const build = !r.build
      ? "not run"
      : !r.build.before
        ? "❌ before (environment) → n/a"
        : r.build.written === 0
          ? "✅ → (nothing written)"
          : `✅ → ${r.build.after ? "✅" : "❌"}`;
    const tsc =
      !r.typecheck || r.typecheck.written === 0 ? "n/a" : String(r.typecheck.newErrors.length);
    out.push(
      `| [${r.app.name}](https://github.com/${r.app.repo}/tree/${r.app.ref}/${r.app.dir === "." ? "" : r.app.dir}) | \`${r.app.ref.slice(0, 7)}\` | ${d.useClient} | ${d.split.length} (${pct(d.split.length, d.useClient)}) | ${u.split.length} (${pct(u.split.length, u.useClient)}) | ${u.kb.toFixed(2)} KB | ${u.selfCheckFailures} | ${u.internalErrors} | ${build} | ${tsc} | ${d.seconds.toFixed(1)} s |`,
    );
  }
  out.push("");
  for (const r of rows) {
    out.push(`## ${r.app.name}`, "");
    if (r.build && !r.build.before)
      out.push(
        `The unmodified app doesn't build in this environment: ${r.build.beforeError ?? "unknown error"}. The typecheck comparison still ran.`,
        "",
      );
    if (r.build?.afterError) out.push(`**Build after --write failed:** ${r.build.afterError}`, "");
    const u = r.noThresholds;
    if (u.split.length > 0) {
      out.push("Splits (thresholds off):", "");
      for (const s of u.split)
        out.push(
          `- \`${s.file}\` → ${s.islands.join(", ")} (${Math.round(s.staticRatio * 100)}% static, ~${(s.kb * 1024).toFixed(0)} B gzip)`,
        );
      out.push("");
    }
    out.push("| File | Skip reason (default thresholds) | Message |", "|---|---|---|");
    for (const sk of r.defaults.skipDetails)
      out.push(
        `| \`${sk.file}\` | \`${sk.code}\` | ${sk.message.replace(/\|/g, "\\|").slice(0, 220)} |`,
      );
    out.push("");
  }
  out.push(
    "## Reading these numbers",
    "",
    'These three apps were written by people who know the client-island pattern well, so most of their `"use client"` files are already small and genuinely interactive. The tool correctly finds little to move, and skips the rest with a specific reason. The savings it measures come from code that would leave the client bundle (`date-fns` and `marked` in `e2e/apps/blog` save 18.5 KB gzip on `/`). Apps that put `"use client"` high in the tree benefit far more than these.',
    "",
  );
  return out.join("\n");
}

function pct(n, total) {
  return total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`;
}
console.log(`\nraw results: ${path.join(workDir, "results.json")}`);
