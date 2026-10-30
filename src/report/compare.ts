import { readFileSync } from "node:fs";
import type { SkipCode } from "../analysis/skip.js";
import { formatBytes, isChange } from "../split.js";
import { summarize } from "../summary.js";
import type { FileResult, RouteSaving, RunSummary } from "../types.js";

/** A JSON report (`--json`): the API result. Reports from before 1.0.3 only have `files`. */
export type Report = { files: FileResult[]; routes?: RouteSaving[]; summary?: RunSummary };

/** What changed between two reports of the same project. */
export type Comparison = {
  /** Changes available now that weren't before (a moved file's change isn't new). */
  added: { file: string; status: FileResult["status"]; bytesSaved?: number }[];
  /** Changes available before that aren't now (applied, or no longer possible). */
  resolved: { file: string; status: FileResult["status"]; bytesSaved?: number; now?: SkipCode }[];
  /** Changes in both whose estimated saving moved by 10% and 100 B or more. */
  resized: { file: string; before: number; after: number }[];
  /** Files skipped now that weren't skipped before (or weren't there), and the reverse. */
  newSkips: { file: string; code: SkipCode }[];
  goneSkips: { file: string; code: SkipCode }[];
  /** Files skipped in both, for a different reason. */
  changedSkips: { file: string; before: SkipCode; after: SkipCode }[];
  before: RunSummary;
  after: RunSummary;
};

/** Reads a JSON report, or says why it can't. */
export function readReport(file: string): { report: Report } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const files = (data as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return { error: "not an auto-server-split JSON report (no files)" };
  // A baseline also has `files`, as paths; a report's are results.
  const isResult = (f: unknown) =>
    typeof f === "object" &&
    f !== null &&
    typeof (f as FileResult).file === "string" &&
    typeof (f as FileResult).status === "string";
  if (!files.every(isResult))
    return {
      error: "not an auto-server-split JSON report (files must be results from --json)",
    };
  return { report: data as Report };
}

export function compareReports(before: Report, after: Report): Comparison {
  const summaryOf = (r: Report) => r.summary ?? summarize(r.files, r.files.length, r.routes);
  const beforeByFile = new Map(before.files.map((f) => [f.file, f]));
  const afterByFile = new Map(after.files.map((f) => [f.file, f]));
  // A change in a file the earlier report didn't have matches an earlier change with the same
  // fingerprint whose file is gone: the component moved. Each earlier change matches once, and a
  // file that's still there never does, since two files can hold a `Card` with a `CardButton`.
  const movable = new Map<string, FileResult[]>();
  for (const f of before.files.filter(isChange))
    if (f.fingerprint && !afterByFile.has(f.file))
      movable.set(f.fingerprint, [...(movable.get(f.fingerprint) ?? []), f]);
  const moved = new Set<string>();
  const saving = (f: FileResult | undefined) => f?.bytesSaved?.conservative;

  const added: Comparison["added"] = [];
  const resized: Comparison["resized"] = [];
  for (const f of after.files.filter(isChange)) {
    const was = beforeByFile.get(f.file);
    if (was && isChange(was)) {
      const a = saving(was);
      const b = saving(f);
      if (a !== undefined && b !== undefined && Math.abs(b - a) >= Math.max(100, a * 0.1))
        resized.push({ file: f.file, before: a, after: b });
      continue;
    }
    const from = !was && f.fingerprint ? movable.get(f.fingerprint)?.shift() : undefined;
    if (from) {
      moved.add(from.file);
      continue;
    }
    added.push({
      file: f.file,
      status: f.status,
      ...(saving(f) !== undefined ? { bytesSaved: saving(f) } : {}),
    });
  }
  const resolved: Comparison["resolved"] = [];
  for (const f of before.files.filter(isChange)) {
    const now = afterByFile.get(f.file);
    if (now && isChange(now)) continue;
    if (moved.has(f.file)) continue;
    resolved.push({
      file: f.file,
      status: f.status,
      ...(saving(f) !== undefined ? { bytesSaved: saving(f) } : {}),
      ...(now?.skipped ? { now: now.skipped.code } : {}),
    });
  }
  const skipsOf = (files: FileResult[]) =>
    new Map(files.flatMap((f) => (f.skipped ? [[f.file, f.skipped.code] as const] : [])));
  const beforeSkips = skipsOf(before.files);
  const afterSkips = skipsOf(after.files);
  const newSkips = [...afterSkips]
    .filter(([file]) => !beforeSkips.has(file))
    .map(([file, code]) => ({ file, code }));
  const goneSkips = [...beforeSkips]
    .filter(([file]) => !afterSkips.has(file))
    .map(([file, code]) => ({ file, code }));
  const changedSkips = [...afterSkips].flatMap(([file, code]) => {
    const was = beforeSkips.get(file);
    return was !== undefined && was !== code ? [{ file, before: was, after: code }] : [];
  });
  return {
    added,
    resolved,
    resized,
    newSkips,
    goneSkips,
    changedSkips,
    before: summaryOf(before),
    after: summaryOf(after),
  };
}

const bytes = (n: number | undefined) => (n === undefined ? "–" : formatBytes(n));
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${formatBytes(Math.abs(n))}`;

/** The comparison as lines of text (or markdown, for a pull request comment). */
export function comparisonLines(c: Comparison, markdown = false): string[] {
  const code = (s: string) => (markdown ? `\`${s}\`` : s);
  const lines: string[] = [
    markdown
      ? "## auto-server-split: compared with the baseline report"
      : "Compared with the earlier report:",
    "",
  ];
  const delta = (c.after.bytesSaved ?? 0) - (c.before.bytesSaved ?? 0);
  lines.push(
    `${markdown ? "- " : "  "}changes available: ${c.before.changes} → ${c.after.changes}`,
    `${markdown ? "- " : "  "}estimated saving: ${bytes(c.before.bytesSaved)} → ${bytes(c.after.bytesSaved)} (${signed(delta)})`,
    `${markdown ? "- " : "  "}"use client" files: ${c.before.useClientFiles} → ${c.after.useClientFiles}`,
    `${markdown ? "- " : "  "}skipped: ${c.before.skipped} → ${c.after.skipped}`,
  );
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", markdown ? `**${title}**` : `${title}:`, "");
    for (const item of items) lines.push(`${markdown ? "- " : "  "}${item}`);
  };
  section(
    "New opportunities",
    c.added.map(
      (a) =>
        `${code(a.file)} (${a.status === "split" ? "split" : 'remove "use client"'}, ${bytes(a.bytesSaved)})`,
    ),
  );
  section(
    "No longer available",
    c.resolved.map(
      (r) => `${code(r.file)}${r.now ? ` (now skipped: ${r.now})` : " (applied or removed)"}`,
    ),
  );
  section(
    "Saving changed",
    c.resized.map((r) => `${code(r.file)}: ${formatBytes(r.before)} → ${formatBytes(r.after)}`),
  );
  section(
    "Newly skipped",
    c.newSkips.map((s) => `${code(s.file)} (${s.code})`),
  );
  section(
    "No longer skipped",
    c.goneSkips.map((s) => `${code(s.file)} (was ${s.code})`),
  );
  section(
    "Skipped for another reason",
    c.changedSkips.map((s) => `${code(s.file)} (${s.before} → ${s.after})`),
  );
  return lines;
}
