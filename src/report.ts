import { SKIP_TITLES } from "./analysis/skip.js";
import { formatBytes, isChange } from "./split.js";
import type { FileResult, SkipCode } from "./types.js";

/** `--format` values that render the whole run (text streams per file, json is the API result). */
export type ReportFormat = "markdown" | "github";

const savingText = (f: FileResult): string =>
  f.bytesSaved
    ? `~${formatBytes(f.bytesSaved.conservative)}`
    : f.measureError
      ? "not measured"
      : "–";

const mdEscape = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

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
      const change = f.status === "split" ? "split" : 'remove `"use client"`';
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
    if (!applied)
      lines.push("", "Apply with `npx auto-server-split --write` (or pass the files to change).");
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

/** Escapes text for a GitHub Actions workflow command: data, or (`property`) a property value. */
function escapeCommand(text: string, property = false): string {
  let out = text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  if (property) out = out.replace(/:/g, "%3A").replace(/,/g, "%2C");
  return out;
}

/**
 * GitHub Actions annotations: a notice on each available change (at its first island), a warning
 * for each change's warnings, and a warning for self-check failures and internal errors.
 * `repoPath` maps a result's path (relative to the project root) to one relative to the repository,
 * which is what GitHub resolves annotations against.
 */
export function githubAnnotations(
  files: FileResult[],
  repoPath: (file: string) => string = (file) => file,
): string[] {
  const out: string[] = [];
  const command = (
    kind: "notice" | "warning",
    file: string,
    line: number | undefined,
    title: string,
    message: string,
  ) =>
    `::${kind} file=${escapeCommand(repoPath(file), true)}${line ? `,line=${line}` : ""},title=${escapeCommand(title, true)}::${escapeCommand(message)}`;
  for (const f of files) {
    if (f.status === "split") {
      const islands = f.islands.map((i) => `${i.name} <${i.rootTag}>`).join(", ");
      const saving = f.bytesSaved ? `, ~${formatBytes(f.bytesSaved.conservative)} gzip saved` : "";
      out.push(
        command(
          "notice",
          f.file,
          f.islands[0]?.line,
          "Split available",
          `${Math.round(f.staticRatio * 100)}% static, ${f.islands.length} island${f.islands.length === 1 ? "" : "s"} (${islands})${saving}. Apply with: npx auto-server-split ${f.file} --write`,
        ),
      );
    } else if (f.status === "directive-removed") {
      out.push(
        command(
          "notice",
          f.file,
          1,
          '"use client" is unnecessary',
          `No client-only code, and every importer is a Server Component. Apply with: npx auto-server-split ${f.file} --remove-unused-directives --write`,
        ),
      );
    } else if (
      f.skipped &&
      (f.skipped.code === "self-check-failed" || f.skipped.code === "internal-error")
    ) {
      out.push(
        command(
          "warning",
          f.file,
          f.skipped.location?.line,
          `auto-server-split ${f.skipped.code}`,
          f.skipped.message.split("\n")[0] ?? f.skipped.message,
        ),
      );
    }
    for (const w of f.warnings ?? [])
      out.push(command("warning", f.file, w.location?.line, w.code, w.message));
  }
  return out;
}
