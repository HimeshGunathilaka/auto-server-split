import { createHash } from "node:crypto";
import { WARNING_CODES } from "../analysis/warnings.js";
import { formatBytes } from "../split.js";
import type { FileResult } from "../types.js";
import { applyCommand } from "./markdown.js";

const HOME = "https://github.com/HimeshGunathilaka/auto-server-split";

type Level = "error" | "warning" | "note";

/** What a report flags: changes, the risks they carry, and the tool's own failures. */
export type Finding = {
  rule: string;
  level: Level;
  file: string;
  line: number | undefined;
  column: number | undefined;
  message: string;
  /** Identifies the finding across runs without its line. */
  fingerprint: string;
};

const RULES: Record<string, { level: Level; description: string; help: string }> = {
  "split-available": {
    level: "note",
    description:
      'A "use client" component can be split into a Server Component plus small client islands',
    help: `${HOME}#before--after`,
  },
  "directive-unnecessary": {
    level: "note",
    description: 'A "use client" file has no client-only code and only Server Components import it',
    help: `${HOME}/blob/main/docs/configuration.md#removeunuseddirectives`,
  },
  "timezone-dependent": {
    level: "warning",
    description: "Date code that rendered in the browser renders on the server after the change",
    help: `${HOME}/blob/main/docs/api.md#warnings`,
  },
  "ignore-outside-header": {
    level: "warning",
    description: "An auto-server-split-ignore comment outside the file header has no effect",
    help: `${HOME}/blob/main/docs/api.md#warnings`,
  },
  rule: {
    level: "warning",
    description: "A call named in the config's rules.warnings runs on the server after the change",
    help: `${HOME}/blob/main/docs/configuration.md#rules`,
  },
  "self-check-failed": {
    level: "error",
    description: "The generated code failed the self-check; nothing was changed",
    help: `${HOME}/blob/main/docs/skip-reasons.md#self-check-failed`,
  },
  "internal-error": {
    level: "error",
    description: "auto-server-split hit an internal error on this file",
    help: `${HOME}/blob/main/docs/skip-reasons.md#parse-error--internal-error`,
  },
};

const hash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

/**
 * The findings of a run: each available change (at its first island), each warning a change
 * carries, and self-check failures and internal errors. Skips are left out: most mean the code is
 * already where it belongs.
 */
export function findings(files: readonly FileResult[]): Finding[] {
  const byFile = new Map(files.map((f) => [f.file, f.status]));
  const out: Finding[] = [];
  for (const f of files) {
    const id = f.fingerprint ?? hash(f.file);
    if (f.status === "split") {
      const islands = f.islands.map((i) => `${i.name} <${i.rootTag}>`).join(", ");
      const saving = f.bytesSaved
        ? `, about ${formatBytes(f.bytesSaved.conservative)} gzip of client JavaScript`
        : "";
      out.push({
        rule: "split-available",
        level: "note",
        file: f.file,
        line: f.islands[0]?.line,
        column: undefined,
        message: `${Math.round(f.staticRatio * 100)}% of this component can render on the server: split it into ${f.islands.length} island${f.islands.length === 1 ? "" : "s"} (${islands})${saving}. Apply with: ${applyCommand(f, (file) => byFile.get(file))}`,
        fingerprint: hash("split-available", id),
      });
    } else if (f.status === "directive-removed") {
      out.push({
        rule: "directive-unnecessary",
        level: "note",
        file: f.file,
        line: 1,
        column: undefined,
        message: `"use client" is unnecessary: the file has no client-only code and only Server Components import it. Apply with: ${applyCommand(f, (file) => byFile.get(file))}`,
        fingerprint: hash("directive-unnecessary", id),
      });
    } else if (f.skipped?.code === "self-check-failed" || f.skipped?.code === "internal-error") {
      out.push({
        rule: f.skipped.code,
        level: "error",
        file: f.file,
        line: f.skipped.location?.line,
        column: f.skipped.location?.column,
        message: f.skipped.message.split("\n")[0] ?? f.skipped.message,
        fingerprint: hash(f.skipped.code, f.file),
      });
    }
    for (const w of f.warnings ?? []) {
      out.push({
        rule: w.code,
        level: "warning",
        file: f.file,
        line: w.location?.line,
        column: w.location?.column,
        message: w.message,
        fingerprint: hash(w.code, id, w.message),
      });
    }
  }
  return uniqueFingerprints(out);
}

/** Identical copies of a component share a fingerprint; code scanning would merge their alerts. */
function uniqueFingerprints(out: Finding[]): Finding[] {
  const seen = new Map<string, number>();
  for (const finding of out) {
    const n = (seen.get(finding.fingerprint) ?? 0) + 1;
    seen.set(finding.fingerprint, n);
    if (n > 1) finding.fingerprint = hash(finding.fingerprint, String(n));
  }
  return out;
}

/**
 * A SARIF 2.1.0 log of the run's findings, for GitHub code scanning and other CI tools. `uri`
 * maps a result's path (relative to the project root) to the path the consumer resolves (relative
 * to the repository on GitHub).
 */
export function sarifReport(
  files: readonly FileResult[],
  version: string,
  uri: (file: string) => string = (file) => file,
): string {
  const ruleIds = [
    "split-available",
    "directive-unnecessary",
    ...WARNING_CODES,
    "self-check-failed",
    "internal-error",
  ];
  const rules = ruleIds.map((id) => {
    const rule = RULES[id];
    return {
      id,
      name: id.replace(/(^|-)(\w)/g, (_, _dash: string, c: string) => c.toUpperCase()),
      shortDescription: { text: rule?.description ?? id },
      helpUri: rule?.help ?? HOME,
      defaultConfiguration: { level: rule?.level ?? "warning" },
    };
  });
  const results = findings(files).map((f) => ({
    ruleId: f.rule,
    ruleIndex: ruleIds.indexOf(f.rule),
    level: f.level,
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: uri(f.file), uriBaseId: "%SRCROOT%" },
          region: { startLine: f.line ?? 1, ...(f.column ? { startColumn: f.column } : {}) },
        },
      },
    ],
    partialFingerprints: { "autoServerSplit/v1": f.fingerprint },
  }));
  const log = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: { name: "auto-server-split", version, informationUri: HOME, rules },
        },
        results,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

/** A GitLab Code Quality report (an array of issues) of the run's findings. */
export function gitlabReport(
  files: readonly FileResult[],
  path: (file: string) => string = (file) => file,
): string {
  const severity: Record<Level, string> = { note: "info", warning: "minor", error: "major" };
  const issues = findings(files).map((f) => ({
    description: f.message,
    check_name: f.rule,
    // Unique within the run (see findings) and free of the path, so a moved change keeps it.
    fingerprint: hash(f.fingerprint),
    severity: severity[f.level],
    location: { path: path(f.file), lines: { begin: f.line ?? 1 } },
  }));
  return `${JSON.stringify(issues, null, 2)}\n`;
}
