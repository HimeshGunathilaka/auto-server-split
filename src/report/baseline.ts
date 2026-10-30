import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";
import { isChange } from "../split.js";
import type { FileResult } from "../types.js";

/** A change recorded in a baseline: where it was and what identifies it after a move. */
export type BaselineEntry = {
  file: string;
  status: "split" | "directive-removed";
  fingerprint?: string;
  /** Estimated gzip bytes it saved when the baseline was written. */
  bytesSaved?: number;
};

/**
 * A baseline file (`--write-baseline`): the changes available when it was written, which
 * `--baseline` leaves as they are, plus every `"use client"` file then (for the new-boundaries
 * budget) and the totals. Version 1 files only have `files`.
 */
export type Baseline = {
  /** 1 for a file written before boundaries were recorded (it reads with no boundaries). */
  version: 1 | 2;
  /** The changed files, relative to the project root (what version 1 holds). */
  files: string[];
  entries: BaselineEntry[];
  /** Every `"use client"` file the run saw. */
  boundaries: string[];
  /** Each boundary's {@link boundaryPrint}, to recognise it after a move or rename. */
  prints?: Record<string, string>;
  totals: { changes: number; bytesSaved?: number; boundaries: number };
};

/**
 * Identifies a `"use client"` file's code without its path: everything but the imports (which a
 * move rewrites), whitespace collapsed, hashed.
 */
export function boundaryPrint(text: string): string {
  const sf = ts.createSourceFile("x.tsx", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const code = sf.statements
    .filter((s) => !ts.isImportDeclaration(s))
    .map((s) => s.getText(sf).replace(/\s+/g, " "))
    .join("\n");
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

/** The baseline for a run's results; `printOf` reads a file's {@link boundaryPrint}. */
export function baselineOf(
  files: readonly FileResult[],
  previous?: Baseline,
  printOf?: (file: string) => string | undefined,
): Baseline {
  const changes = files.filter(isChange);
  const measured = changes.filter((f) => f.bytesSaved);
  const entries: BaselineEntry[] = changes
    .map((f) => ({
      file: f.file,
      status: f.status as BaselineEntry["status"],
      ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
      ...(f.bytesSaved ? { bytesSaved: f.bytesSaved.conservative } : {}),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const boundaries = [
    ...new Set([...files.map((f) => f.file), ...(previous?.boundaries ?? [])]),
  ].sort();
  const prints: Record<string, string> = {};
  for (const file of boundaries) {
    const print =
      (files.some((f) => f.file === file) ? printOf?.(file) : undefined) ??
      previous?.prints?.[file];
    if (print) prints[file] = print;
  }
  return {
    version: 2,
    files: entries.map((e) => e.file),
    entries,
    boundaries,
    ...(Object.keys(prints).length > 0 ? { prints } : {}),
    totals: {
      changes: entries.length,
      ...(measured.length > 0
        ? { bytesSaved: measured.reduce((n, f) => n + (f.bytesSaved?.conservative ?? 0), 0) }
        : {}),
      boundaries: boundaries.length,
    },
  };
}

/** Reads a baseline file (version 1 or 2), or says why it can't. */
export function readBaseline(file: string): { baseline: Baseline } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const value = data as Partial<Baseline> | null;
  const files = value?.files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string"))
    return { error: 'expected { "files": ["path", ...] }' };
  const entries = Array.isArray(value?.entries)
    ? value.entries.filter(
        (e): e is BaselineEntry =>
          typeof e === "object" && e !== null && typeof (e as BaselineEntry).file === "string",
      )
    : files.map((f) => ({ file: f, status: "split" as const }));
  const boundaries = Array.isArray(value?.boundaries)
    ? value.boundaries.filter((f): f is string => typeof f === "string")
    : [];
  const prints =
    typeof value?.prints === "object" && value.prints !== null
      ? Object.fromEntries(Object.entries(value.prints).filter(([, p]) => typeof p === "string"))
      : undefined;
  return {
    baseline: {
      version: value?.version === 2 ? 2 : 1,
      files,
      entries,
      boundaries,
      ...(prints ? { prints } : {}),
      totals: {
        changes: entries.length,
        ...(typeof value?.totals?.bytesSaved === "number"
          ? { bytesSaved: value.totals.bytesSaved }
          : {}),
        boundaries: boundaries.length,
      },
    },
  };
}

/**
 * Changes a baseline covers although their file isn't listed: the entry's file is gone and the
 * change has its fingerprint (the component moved or was renamed). Maps the file to the entry's.
 */
export function movedBaselineChanges(
  baseline: Baseline,
  files: readonly FileResult[],
  exists: (file: string) => boolean,
): Map<string, string> {
  const listed = new Set(baseline.files);
  const gone = new Map<string, BaselineEntry[]>();
  for (const entry of baseline.entries) {
    if (!entry.fingerprint || exists(entry.file)) continue;
    gone.set(entry.fingerprint, [...(gone.get(entry.fingerprint) ?? []), entry]);
  }
  const moved = new Map<string, string>();
  for (const f of files) {
    if (!isChange(f) || !f.fingerprint || listed.has(f.file)) continue;
    const [entry, ...more] = gone.get(f.fingerprint) ?? [];
    // Two entries with the same fingerprint can't tell which one moved here.
    if (entry && more.length === 0) moved.set(f.file, entry.file);
  }
  return moved;
}

/**
 * The `"use client"` files of a run that aren't among the baseline's boundaries. A file that isn't
 * listed matches a listed one whose file is gone (it moved or was renamed) when it's the same
 * change, has the same file name, or has the same code ({@link boundaryPrint}). Each gone
 * boundary matches once.
 */
export function newBoundaryFiles(
  baseline: Baseline,
  files: readonly string[],
  exists: (file: string) => boolean,
  moved: ReadonlyMap<string, string> = new Map(),
  printOf: (file: string) => string | undefined = () => undefined,
): string[] {
  const listed = new Set(baseline.boundaries);
  const gone = baseline.boundaries.filter((f) => !exists(f));
  const take = (match: (g: string) => boolean) => {
    const i = gone.findIndex(match);
    if (i >= 0) gone.splice(i, 1);
    return i >= 0;
  };
  const name = (f: string) => path.posix.basename(f);
  return files
    .filter((f) => !listed.has(f))
    .filter((f) => !take((g) => g === moved.get(f)))
    .filter((f) => {
      const print = printOf(f);
      return !take((g) => print !== undefined && baseline.prints?.[g] === print);
    })
    .filter((f) => !take((g) => name(g) === name(f)));
}
