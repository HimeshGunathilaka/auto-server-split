import { SKIP_TITLES } from "../analysis/skip.js";
import { formatBytes, isChange } from "../split.js";
import type { FileResult, SkipCode } from "../types.js";

const savingText = (f: FileResult): string =>
  f.bytesSaved
    ? `~${formatBytes(f.bytesSaved.conservative)}`
    : f.measureError
      ? "not measured"
      : "–";

const mdEscape = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** An argument quoted for a POSIX shell when it needs it: `app/(shop)/My Card.tsx` gets quotes. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The command that applies one change: the file, plus the changes it needs (`requires`), and
 * `--remove-unused-directives` when one of them removes a directive.
 */
export function applyCommand(
  f: FileResult,
  statusOf: (file: string) => FileResult["status"] | undefined,
) {
  const files = [...(f.requires ?? []), f.file];
  const removes = files.some(
    (file) => (file === f.file ? f.status : statusOf(file)) === "directive-removed",
  );
  return `npx auto-server-split ${files.map(shellQuote).join(" ")}${removes ? " --remove-unused-directives" : ""} --write`;
}

/**
 * A markdown report of the run, for a pull request comment or a CI job summary: the changes
 * available (or applied), their warnings, and the skips grouped by reason.
 */
export function markdownReport(
  files: FileResult[],
  filesScanned: number,
  applied: boolean,
): string {
  const changes = files.filter(isChange);
  const skipped = files.filter((f) => f.status === "skipped");
  const saved = changes.reduce((n, f) => n + (f.bytesSaved?.conservative ?? 0), 0);
  const lines: string[] = ["## auto-server-split", ""];
  const verb = applied ? "applied" : "available";
  lines.push(
    `${changes.length} change${changes.length === 1 ? "" : "s"} ${verb} in ${files.length} \`"use client"\` file${files.length === 1 ? "" : "s"} (${filesScanned} scanned)` +
      (files.some((f) => f.bytesSaved)
        ? `, about ${formatBytes(saved)} gzip of client JavaScript.`
        : "."),
  );
  if (changes.length > 0) {
    lines.push(
      "",
      "| File | Change | Islands | Saving (gzip, est.) |",
      "| --- | --- | --- | --- |",
    );
    for (const f of changes) {
      const needs = f.requires?.length
        ? ` (needs ${f.requires.map((r) => `\`${r}\``).join(", ")})`
        : "";
      const change = (f.status === "split" ? "split" : 'remove `"use client"`') + needs;
      const islands = f.islands.map((i) => `\`${i.name}\``).join(", ") || "–";
      lines.push(`| \`${f.file}\` | ${change} | ${islands} | ${savingText(f)} |`);
    }
    const warned = changes.filter((f) => f.warnings?.length);
    if (warned.length > 0) {
      lines.push("", "**Check before applying:**", "");
      for (const f of warned)
        for (const w of f.warnings ?? [])
          lines.push(
            `- \`${f.file}${w.location ? `:${w.location.line}` : ""}\`: ${mdEscape(w.message)}`,
          );
    }
    if (!applied) {
      const flag = changes.some((f) => f.status === "directive-removed")
        ? " --remove-unused-directives"
        : "";
      const needs = changes.some((f) => f.requires?.length) ? ", with the files they need" : "";
      lines.push(
        "",
        `Apply with \`npx auto-server-split${flag} --write\` (or pass the files to change${needs}).`,
      );
    }
  }
  if (skipped.length > 0) {
    const byCode = new Map<SkipCode, FileResult[]>();
    for (const f of skipped) {
      const code = f.skipped?.code;
      if (code) byCode.set(code, [...(byCode.get(code) ?? []), f]);
    }
    lines.push("", "<details><summary>Skipped files</summary>", "");
    lines.push("| Reason | Files |", "| --- | --- |");
    for (const [code, list] of [...byCode].sort((a, b) => b[1].length - a[1].length)) {
      const names = list.map((f) => `\`${f.file}\``).join(", ");
      lines.push(`| \`${code}\`: ${SKIP_TITLES[code]} | ${names} |`);
    }
    lines.push("", "</details>");
  }
  return `${lines.join("\n")}\n`;
}
