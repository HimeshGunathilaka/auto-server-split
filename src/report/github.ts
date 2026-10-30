import { formatBytes } from "../split.js";
import type { FileResult } from "../types.js";
import { applyCommand } from "./markdown.js";

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
  const byFile = new Map(files.map((f) => [f.file, f.status]));
  const statusOf = (file: string) => byFile.get(file);
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
          `${Math.round(f.staticRatio * 100)}% static, ${f.islands.length} island${f.islands.length === 1 ? "" : "s"} (${islands})${saving}. Apply with: ${applyCommand(f, statusOf)}`,
        ),
      );
    } else if (f.status === "directive-removed") {
      out.push(
        command(
          "notice",
          f.file,
          1,
          '"use client" is unnecessary',
          `No client-only code, and every importer is a Server Component. Apply with: ${applyCommand(f, statusOf)}`,
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
