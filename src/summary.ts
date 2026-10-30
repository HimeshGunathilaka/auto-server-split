import pc from "picocolors";
import { SKIP_TITLES } from "./analysis/skip.js";
import { formatBytes, isChange } from "./split.js";
import type { FileResult, RouteSaving, RunSummary, SkipCode, WarningCode } from "./types.js";

/** The numbers of a run, for reports, budgets and comparisons. */
export function summarize(
  files: readonly FileResult[],
  filesScanned: number,
  routes: readonly RouteSaving[] = [],
): RunSummary {
  const changes = files.filter(isChange);
  const skippedByCode: Partial<Record<SkipCode, number>> = {};
  const warnings: Partial<Record<WarningCode, number>> = {};
  for (const f of files) {
    if (f.skipped) skippedByCode[f.skipped.code] = (skippedByCode[f.skipped.code] ?? 0) + 1;
    for (const w of f.warnings ?? []) warnings[w.code] = (warnings[w.code] ?? 0) + 1;
  }
  const measured = changes.filter((f) => f.bytesSaved);
  const best = [...routes].sort((a, b) => (b.initialSaved ?? 0) - (a.initialSaved ?? 0))[0];
  return {
    filesScanned,
    useClientFiles: files.length,
    changes: changes.length,
    splits: changes.filter((f) => f.status === "split").length,
    directivesRemoved: changes.filter((f) => f.status === "directive-removed").length,
    islands: changes.reduce((n, f) => n + f.islands.length, 0),
    skipped: files.filter((f) => f.status === "skipped").length,
    skippedByCode,
    ...(measured.length > 0
      ? { bytesSaved: measured.reduce((n, f) => n + (f.bytesSaved?.conservative ?? 0), 0) }
      : {}),
    unmeasured: changes.filter((f) => f.measureError).length,
    warnings,
    routes: routes.length,
    ...(best?.initialSaved !== undefined
      ? { bestRoute: { route: best.route, initialSaved: best.initialSaved } }
      : {}),
  };
}

type SummaryInput = {
  /** Every "use client" file's result. */
  files: FileResult[];
  filesScanned: number;
  mode: "dry-run" | "write" | "check" | "interactive";
  /**
   * The changes (splits and removed directives) applied (`--write`, accepted in `--interactive`) or
   * available (dry run, `--check`).
   */
  splits: FileResult[];
  /** Interactive mode: proposed changes that weren't accepted. */
  declined: number;
  /** What the changes save per route. */
  routes?: readonly RouteSaving[];
};

/**
 * The CLI's closing summary: files scanned, split, with the directive removed, declined and
 * skipped, and the estimated saving.
 */
export function summaryLines({
  files,
  filesScanned,
  mode,
  splits,
  declined,
  routes = [],
}: SummaryInput): string[] {
  const lines: string[] = [];
  const skipped = files.filter((f) => f.status === "skipped");
  const byCode = new Map<SkipCode, number>();
  for (const f of skipped)
    if (f.skipped) byCode.set(f.skipped.code, (byCode.get(f.skipped.code) ?? 0) + 1);
  const saved = splits.reduce((n, f) => n + (f.bytesSaved?.conservative ?? 0), 0);
  lines.push("", pc.bold("Summary"));
  lines.push(`  files scanned:  ${filesScanned} (${files.length} with "use client")`);
  const written = mode === "write" || mode === "interactive";
  const writeNote = mode === "check" ? "" : " (dry run, nothing written)";
  const split = splits.filter((f) => f.status === "split").length;
  const removed = splits.length - split;
  const note = (n: number) => (written ? ` (${n} written)` : writeNote);
  lines.push(`  files split:    ${split}${note(split)}`);
  if (removed > 0) lines.push(`  directives removed: ${removed}${note(removed)}`);
  if (declined > 0) lines.push(`  files declined: ${declined} (proposed changes not accepted)`);
  lines.push(`  files skipped:  ${skipped.length}`);
  for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${String(count).padStart(3)}  ${code.padEnd(30)} ${pc.dim(SKIP_TITLES[code])}`);
  }
  const unmeasured = splits.filter((f) => f.measureError).length;
  const unmeasuredNote =
    unmeasured > 0 ? ` (${unmeasured} split${unmeasured === 1 ? "" : "s"} not measured)` : "";
  if (files.some((f) => f.bytesSaved))
    lines.push(
      `  estimated saving: ${formatBytes(saved)} gzip of client JavaScript${unmeasuredNote}`,
    );
  else if (unmeasured > 0) lines.push(`  estimated saving: unknown${unmeasuredNote}`);
  const best = [...routes].sort((a, b) => (b.initialSaved ?? 0) - (a.initialSaved ?? 0))[0];
  if (routes.length > 0) {
    const most =
      best?.initialSaved !== undefined
        ? `; most on ${best.route}: ~${formatBytes(best.initialSaved)} less up front${best.source === "next-analyze" ? " (Next.js analyzer)" : ""}`
        : "";
    lines.push(`  routes affected: ${routes.length}${most}`);
  }
  if (!written && mode !== "check" && splits.length > 0)
    lines.push(pc.dim("\nRun again with --write to apply."));
  return lines;
}

export /**
 * The route savings of the changes accepted in `--interactive`. A route keeps its totals when every
 * change on it was accepted; otherwise they're the accepted changes' own savings on it, added up.
 */
function acceptedRoutes(routes: readonly RouteSaving[], accepted: readonly FileResult[]) {
  const byFile = new Map(accepted.map((f) => [f.file, f]));
  return routes.flatMap((r): RouteSaving[] => {
    const files = r.files.filter((f) => byFile.has(f));
    if (files.length === 0) return [];
    if (files.length === r.files.length) return [r];
    const saved = (load: "initial" | "lazy") =>
      files.reduce((n, f) => {
        const on = byFile.get(f)?.routes?.find((x) => x.route === r.route && x.load === load);
        return n + (on?.bytesSaved ?? 0);
      }, 0);
    return [
      {
        ...r,
        files,
        ...(r.initialSaved !== undefined ? { initialSaved: saved("initial") } : {}),
        ...(r.lazySaved !== undefined ? { lazySaved: saved("lazy") } : {}),
      },
    ];
  });
}
