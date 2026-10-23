import pc from "picocolors";
import { SKIP_TITLES } from "./analysis/skip.js";
import { formatBytes } from "./split.js";
import type { FileResult, SkipCode } from "./types.js";

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
  if (!written && mode !== "check" && splits.length > 0)
    lines.push(pc.dim("\nRun again with --write to apply."));
  return lines;
}
