import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { packageOfInput } from "./bundleSize.js";

/** Compressed client JavaScript per module, for one route of a Next.js analyzer snapshot. */
export type SnapshotRoute = {
  /** Loaded with the route (bootstrap and render-dependent chunks): module key -> bytes. */
  initial: Map<string, number>;
  /** Loaded later (async chunks: `next/dynamic`, `import()`). */
  lazy: Map<string, number>;
  /** All initial client JavaScript of the route, gzip bytes as the analyzer attributes them. */
  initialBytes: number;
};

/**
 * What a `next analyze` snapshot says about each route's client JavaScript. Module keys are
 * project-relative paths for project files and package names for dependencies, as in
 * {@link moduleKey}.
 */
export type AnalyzerSnapshot = { name: string; routes: Map<string, SnapshotRoute> };

/**
 * The key a module is attributed under: its path relative to the project root, or the name of the
 * package it belongs to.
 */
export function moduleKey(root: string, file: string): string {
  return (
    packageOfInput(file.split(path.sep).join("/")) ??
    path.relative(root, file).split(path.sep).join("/")
  );
}

type Line = { type?: unknown; [key: string]: unknown };

/**
 * Parses the JSON Lines `next analyze export` prints (schema `next/analyze/graph-v1.schema.json`)
 * into per-route client bytes. `[project]/` paths are relative to the Turbopack root, which can be
 * an ancestor of `root` (a monorepo or lockfile root); it's found by locating the project's files.
 */
export function parseAnalyzerExport(
  text: string,
  root: string,
): AnalyzerSnapshot | { error: string } {
  const lines: Line[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      return { error: `line ${i + 1} isn't JSON` };
    }
  }
  const meta = lines.find((l) => l.type === "meta");
  if (!meta) return { error: "no meta record; is this `next analyze export` output?" };
  if (meta.schema_version !== 1)
    return { error: `analyzer schema ${String(meta.schema_version)} isn't supported (expected 1)` };

  const parts = lines.filter(
    (l) =>
      l.type === "part" &&
      typeof l.route === "string" &&
      typeof l.filename === "string" &&
      typeof l.source_path === "string" &&
      typeof l.compressed_size === "number" &&
      l.filename.startsWith("[client-fs]/") &&
      l.filename.endsWith(".js"),
  ) as unknown as {
    route: string;
    filename: string;
    source_path: string;
    compressed_size: number;
  }[];
  const base = turbopackRoot(
    root,
    parts.map((p) => p.source_path),
  );

  // Which emitted files each route loads up front, and which only later.
  const initialFiles = new Map<string, Set<string>>();
  const lazyFiles = new Map<string, Set<string>>();
  const groupsKnown = new Set<string>();
  for (const l of lines) {
    if (l.type === "route" && typeof l.route === "string") {
      const coverage = l.coverage as { groups?: unknown } | undefined;
      if (coverage?.groups === "exact") groupsKnown.add(l.route);
    }
    if (l.type !== "group" || typeof l.route !== "string" || !Array.isArray(l.outputs)) continue;
    const kind = String(l.kind);
    const into = kind === "bootstrap" || kind === "render_dependent" ? initialFiles : lazyFiles;
    const set = into.get(l.route) ?? new Set<string>();
    for (const output of l.outputs) if (typeof output === "string") set.add(output);
    into.set(l.route, set);
  }

  const routes = new Map<string, SnapshotRoute>();
  for (const part of parts) {
    const key = snapshotKey(root, base, part.source_path);
    if (!key) continue;
    const entry = routes.get(part.route) ?? {
      initial: new Map(),
      lazy: new Map(),
      initialBytes: 0,
    };
    routes.set(part.route, entry);
    const initial =
      !groupsKnown.has(part.route) ||
      initialFiles.get(part.route)?.has(part.filename) === true ||
      lazyFiles.get(part.route)?.has(part.filename) !== true;
    const into = initial ? entry.initial : entry.lazy;
    into.set(key, (into.get(key) ?? 0) + part.compressed_size);
    if (initial) entry.initialBytes += part.compressed_size;
  }
  return { name: String(meta.snapshot_name ?? ""), routes };
}

/** The directory `[project]/` stands for: `root` or the ancestor where the project's files are. */
function turbopackRoot(root: string, sourcePaths: string[]): string {
  const samples = sourcePaths
    .filter((p) => p.startsWith("[project]/") && !p.includes("/node_modules/"))
    .slice(0, 50)
    .map((p) => p.slice("[project]/".length));
  if (samples.length === 0) return root;
  let best = { dir: root, found: -1 };
  for (let dir = root, depth = 0; depth < 12; depth++) {
    const found = samples.filter((p) => existsSync(path.join(dir, p))).length;
    if (found > best.found) best = { dir, found };
    if (found === samples.length) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return best.dir;
}

function snapshotKey(root: string, base: string, sourcePath: string): string | undefined {
  if (!sourcePath.startsWith("[project]/")) return undefined;
  const rel = sourcePath.slice("[project]/".length).split("?")[0] ?? "";
  if (rel.includes("node_modules/")) return packageOfInput(rel);
  const abs = path.join(base, rel);
  if (!abs.startsWith(`${root}${path.sep}`)) return undefined;
  return moduleKey(root, abs);
}

/**
 * Reads a snapshot: a `.jsonl` file `next analyze export` wrote, or a directory (the app, its
 * `.next`, or `.next/diagnostics/analyze`) whose latest saved snapshot is exported with the
 * project's own `next` (read-only: it doesn't build).
 */
export function readAnalyzerSnapshot(
  root: string,
  target: string,
): AnalyzerSnapshot | { error: string } {
  const abs = path.resolve(root, target);
  if (!existsSync(abs)) return { error: "it doesn't exist" };
  if (statSync(abs).isFile()) return parseAnalyzerExport(readFileSync(abs, "utf8"), root);

  let appDir = abs;
  let distDir = ".next";
  if (abs.endsWith(path.join("diagnostics", "analyze"))) {
    distDir = path.basename(path.dirname(path.dirname(abs)));
    appDir = path.dirname(path.dirname(path.dirname(abs)));
  } else if (existsSync(path.join(abs, "diagnostics", "analyze"))) {
    distDir = path.basename(abs);
    appDir = path.dirname(abs);
  }
  if (!existsSync(path.join(appDir, distDir, "diagnostics", "analyze", "history"))) {
    return {
      error: `no saved analyzer snapshot in ${path.relative(root, appDir) || "."}; run \`npx next analyze --output\` first`,
    };
  }
  let nextBin: string;
  try {
    nextBin = createRequire(path.join(appDir, "package.json")).resolve("next/dist/bin/next");
  } catch {
    return { error: "can't find the project's `next` package to export the snapshot" };
  }
  try {
    const out = execFileSync(
      process.execPath,
      [nextBin, "analyze", "export", appDir, "--dist-dir", distDir],
      {
        cwd: appDir,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      },
    );
    return parseAnalyzerExport(out, root);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return {
      error: `\`next analyze export\` failed: ${stderr.trim().split("\n")[0] ?? String(error)}`,
    };
  }
}
