import { watch } from "node:fs";
import pc from "picocolors";
import { isChange } from "../split.js";
import type { FileResult } from "../types.js";

const SOURCE_RE = /\.(tsx?|jsx?|mts|cts|mjs|cjs|mdx|json)$/;
/** Ignored at any depth. */
const IGNORED = new Set(["node_modules", ".next", ".git", ".turbo", ".vercel"]);
/** Ignored only at the project root: `app/build/page.tsx` is a route, `build/` is output. */
const IGNORED_AT_ROOT = new Set(["dist", "out", "build", "coverage"]);
/** The compiled copy of a TypeScript config that each run writes next to it and then deletes. */
const TEMP_CONFIG_RE = /(^|[\\/])\.auto-split\.config\.\d+\.\d+\.mjs$/;

/** Whether a change to `rel` (relative to the project root) should trigger a re-analysis. */
export function isWatchedPath(rel: string): boolean {
  if (!SOURCE_RE.test(rel) || TEMP_CONFIG_RE.test(rel)) return false;
  const parts = rel.split(/[\\/]/);
  return !IGNORED_AT_ROOT.has(parts[0] ?? "") && !parts.some((part) => IGNORED.has(part));
}

/** What identifies a result for watch output: changed when this does. */
const stateOf = (f: FileResult) =>
  `${f.status}|${f.fingerprint ?? ""}|${f.skipped?.code ?? ""}|${f.skipped?.message ?? ""}|${f.bytesSaved?.conservative ?? ""}|${f.warnings?.length ?? 0}`;

/**
 * `--watch`: runs the analysis, then again whenever a source file under `root` changes, and prints
 * the results that differ from the previous run. Each run sees the project as it is on disk; bundles
 * stay cached between runs, so only changed files are measured again. Never writes anything.
 */
export async function watchProject(input: {
  root: string;
  run: () => Promise<FileResult[]>;
  describe: (file: FileResult) => string;
  log: (line?: string) => void;
}): Promise<void> {
  const { root, run, describe, log } = input;
  let previous = new Map<string, FileResult>();
  const analyse = async (initial: boolean, changed: number) => {
    const started = Date.now();
    let files: FileResult[];
    try {
      files = await run();
    } catch (error) {
      log(pc.red(`auto-server-split: ${(error as Error).message}`));
      return;
    }
    const next = new Map(files.map((f) => [f.file, f]));
    const lines: string[] = [];
    for (const f of files) {
      const before = previous.get(f.file);
      if (!initial && before && stateOf(before) === stateOf(f)) continue;
      lines.push(describe(f));
    }
    for (const [file, before] of previous)
      if (!next.has(file) && isChange(before))
        lines.push(pc.dim(`– ${file}: no longer a "use client" file`));
    previous = next;
    const changes = files.filter(isChange).length;
    const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    if (!initial)
      log(
        pc.dim(`\n↻ ${changed} file${changed === 1 ? "" : "s"} changed · re-analysed in ${took}`),
      );
    for (const line of lines) log(line);
    if (!initial && lines.length === 0) log(pc.dim("  no result changed"));
    log(
      pc.dim(
        `${initial ? "\n" : ""}${changes} change${changes === 1 ? "" : "s"} available · watching for changes (Ctrl-C to stop)`,
      ),
    );
  };

  await analyse(true, 0);
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const flush = async () => {
    if (running) return;
    const count = pending.size;
    pending = new Set();
    running = analyse(false, count);
    await running;
    running = undefined;
    if (pending.size > 0) void flush();
  };
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (!name) return;
    const rel = name.toString();
    if (!isWatchedPath(rel)) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 250);
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      watcher.close();
      clearTimeout(timer);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
