#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { ConfigError } from "./config/config.js";
import { githubAnnotations, markdownReport } from "./report.js";
import { formatBytes, isChange, runSplit } from "./split.js";
import { summaryLines } from "./summary.js";
import type { FileResult } from "./types.js";

declare const __VERSION__: string;

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_SPLITS_AVAILABLE = 2;

function colorDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("==="))
        return pc.bold(line);
      if (line.startsWith("+")) return pc.green(line);
      if (line.startsWith("-")) return pc.red(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      return line;
    })
    .join("\n");
}

function savedText(file: FileResult, assumes = ""): string {
  return file.bytesSaved
    ? ` · ~${formatBytes(file.bytesSaved.conservative)} gzip saved (estimated${assumes})`
    : file.measureError
      ? ` · ${pc.yellow("saving not measured")} (${file.measureError})`
      : "";
}

/** The changes a later pass found this one after: they have to be applied with it. */
function needsText(file: FileResult): string {
  const needs = file.requires ?? [];
  if (needs.length === 0) return "";
  const list = needs.length <= 2 ? needs.join(" and ") : `${needs.length} other changes`;
  return ` · ${pc.dim(`needs ${list} changed too`)}`;
}

function describeWarnings(file: FileResult): string {
  return (file.warnings ?? [])
    .map((w) => {
      const loc = w.location ? `:${w.location.line}:${w.location.column}` : "";
      return `\n    ${pc.yellow("⚠")} ${file.file}${loc} ${pc.dim(`[${w.code}]`)} ${w.message}`;
    })
    .join("");
}

function describeChange(file: FileResult): string {
  return describeChangeLine(file) + describeWarnings(file);
}

function describeChangeLine(file: FileResult): string {
  if (file.status === "directive-removed")
    return `${pc.green('✔ removed "use client"')} ${pc.bold(file.file)} · no client-only code${savedText(file)}${needsText(file)}`;
  const islands = file.islands.map(
    (i) => `${i.name} <${i.rootTag}>${i.props.length ? ` (props: ${i.props.join(", ")})` : ""}`,
  );
  const shared = file.bytesSaved?.sharedWith ?? [];
  const assumes =
    shared.length === 0
      ? ""
      : shared.length <= 2
        ? `; assumes ${shared.join(" and ")} ${shared.length === 1 ? "is" : "are"} changed too`
        : `; assumes ${shared.length} other files are changed too`;
  const saved = savedText(file, assumes);
  return `${pc.green("✔ split")} ${pc.bold(file.file)} · ${file.islands.length} island${file.islands.length === 1 ? "" : "s"} · ${Math.round(file.staticRatio * 100)}% static${saved}${needsText(file)}\n    ${islands.join("\n    ")}`;
}

function describeSkip(file: FileResult, verbose: boolean): string {
  const s = file.skipped;
  if (!s) return "";
  const loc = s.location ? `:${s.location.line}:${s.location.column}` : "";
  let message = s.message;
  if (s.code === "internal-error" && !verbose) message = message.split("\n")[0] ?? message;
  const color = s.code === "internal-error" || s.code === "self-check-failed" ? pc.red : pc.yellow;
  return `${color("– skipped")} ${file.file}${loc} ${pc.dim(`[${s.code}]`)} ${message}`;
}

/**
 * Target files that git can't restore: modified, staged, untracked or ignored. Undefined when git
 * can't tell us (not a repository).
 */
function dirtyFiles(cwd: string, files: string[]): string[] | undefined {
  if (files.length === 0) return [];
  try {
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain",
        "--ignored",
        "--untracked-files=all",
        "--",
        ...files,
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          `${l.slice(3)}${l.startsWith("!!") ? " (ignored by git)" : l.startsWith("??") ? " (untracked)" : ""}`,
      );
  } catch {
    return undefined;
  }
}

/**
 * Files changed since `ref` (committed on this branch since it forked, modified, or untracked),
 * relative to `root`. Undefined when git can't tell (not a repository, unknown ref, shallow clone).
 */
function changedFiles(root: string, ref: string): string[] | undefined {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    // -z: paths as they are, not quoted and escaped (git quotes non-ASCII names otherwise).
    const out = [
      git("diff", "--name-only", "-z", "--relative", "--diff-filter=ACMR", `${ref}...HEAD`),
      git("diff", "--name-only", "-z", "--relative", "--diff-filter=ACMR", "HEAD"),
      git("ls-files", "-z", "--others", "--exclude-standard"),
    ];
    return [...new Set(out.join("\0").split("\0").filter(Boolean))];
  } catch {
    return undefined;
  }
}

/** A baseline file's list of files (relative to the project root), or why it can't be read. */
function readBaseline(file: string): { files: string[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const files = (data as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string"))
    return { error: 'expected { "files": ["path", ...] }' };
  return { files };
}

const main = defineCommand({
  meta: {
    name: "auto-server-split",
    version: typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev",
    description:
      'Split partly-interactive "use client" components into a Server Component plus small client islands.',
  },
  args: {
    paths: {
      type: "positional",
      required: false,
      description: "Files or directories (default: the config `include` globs)",
    },
    "dry-run": { type: "boolean", description: "Show the diff without writing anything (default)" },
    write: { type: "boolean", description: "Apply the changes" },
    check: {
      type: "boolean",
      description: "CI mode: exit 2 if any change is available, change nothing",
    },
    interactive: {
      type: "boolean",
      description: "Review each proposed split ([y]es/[n]o/[r]ename/[d]iff/[q]uit)",
    },
    json: {
      type: "boolean",
      description: "Print a machine-readable report (same as --format json)",
    },
    format: {
      type: "string",
      description:
        "Output: text (default), json, markdown (a report for PR comments), github (text plus annotations and a job summary)",
    },
    config: {
      type: "string",
      description: "Config file (default: auto-split.config.* in the project root)",
    },
    root: { type: "string", description: "Project root (where tsconfig.json lives; default: cwd)" },
    "allow-dirty": {
      type: "boolean",
      description: "Allow --write on files with uncommitted git changes",
    },
    since: {
      type: "string",
      description:
        "Only files changed since this git ref (e.g. origin/main), plus uncommitted ones",
    },
    baseline: {
      type: "string",
      description:
        "Leave the files listed in this baseline file as they are (see --write-baseline)",
    },
    "write-baseline": {
      type: "string",
      description: "Write the files that have a change available to this baseline file",
    },
    verbose: { type: "boolean", description: "Show stack traces for internal errors" },
    measure: {
      type: "boolean",
      default: true,
      description: "Measure bundle sizes with esbuild (--no-measure to skip)",
    },
    "remove-unused-directives": {
      type: "boolean",
      description: 'Also remove "use client" from files with no client-only code',
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const rootArg = path.resolve(cwd, args.root ?? ".");
    if (!existsSync(rootArg)) {
      console.error(pc.red(`auto-server-split: ${args.root ?? "."} does not exist`));
      process.exitCode = EXIT_ERROR;
      return;
    }
    const root = realpathSync(rootArg);
    const positional = (args._ as string[]).filter(Boolean);
    for (const p of positional) {
      if (!existsSync(path.resolve(cwd, p))) {
        console.error(pc.red(`auto-server-split: ${p} does not exist`));
        process.exitCode = EXIT_ERROR;
        return;
      }
    }
    const paths = positional.map(
      (p) => path.relative(root, realpathSync(path.resolve(cwd, p))) || ".",
    );
    if (args.json && args.format !== undefined && args.format !== "json") {
      console.error(
        pc.red(
          `auto-server-split: --json is --format json, so it can't be combined with --format ${args.format}`,
        ),
      );
      process.exitCode = EXIT_ERROR;
      return;
    }
    const format = args.json ? "json" : (args.format ?? "text");
    if (!["text", "json", "markdown", "github"].includes(format)) {
      console.error(
        pc.red(`auto-server-split: --format must be text, json, markdown or github, got ${format}`),
      );
      process.exitCode = EXIT_ERROR;
      return;
    }
    // --interactive writes the splits you accept, so it can't be a dry run.
    if (
      args.interactive &&
      (args["dry-run"] || args.check || format === "json" || format === "markdown")
    ) {
      console.error(
        pc.red(
          "auto-server-split: --interactive can't be combined with --dry-run, --check, --json or --format markdown",
        ),
      );
      process.exitCode = EXIT_ERROR;
      return;
    }
    if (args.interactive && !process.stdin.isTTY) {
      console.error(pc.red("auto-server-split: --interactive needs a terminal"));
      process.exitCode = EXIT_ERROR;
      return;
    }
    const modes = [args["dry-run"], args.write, args.check].filter(Boolean).length;
    if (modes > 1) {
      console.error(pc.red("auto-server-split: use only one of --dry-run, --write, --check"));
      process.exitCode = EXIT_ERROR;
      return;
    }
    if (args["write-baseline"] && (args.write || args.interactive || args.baseline)) {
      console.error(
        pc.red(
          "auto-server-split: --write-baseline can't be combined with --write, --interactive or --baseline",
        ),
      );
      process.exitCode = EXIT_ERROR;
      return;
    }
    if (args.since?.startsWith("-")) {
      console.error(pc.red(`auto-server-split: --since needs a git ref, got ${args.since}`));
      process.exitCode = EXIT_ERROR;
      return;
    }
    const only = args.since === undefined ? undefined : changedFiles(root, args.since);
    if (args.since !== undefined && !only) {
      console.error(
        pc.red(
          `auto-server-split: can't list the files changed since ${args.since} (not a git repository, an unknown ref, or a shallow clone without it?)`,
        ),
      );
      process.exitCode = EXIT_ERROR;
      return;
    }
    let baseline: string[] | undefined;
    if (args.baseline) {
      const read = readBaseline(path.resolve(cwd, args.baseline));
      if ("error" in read) {
        console.error(pc.red(`auto-server-split: can't read ${args.baseline}: ${read.error}`));
        process.exitCode = EXIT_ERROR;
        return;
      }
      baseline = read.files;
    }
    const verbose = Boolean(args.verbose);
    // json and markdown print one report at the end instead of the per-file text.
    const quiet = format === "json" || format === "markdown";
    const log = (line = "") => {
      if (!quiet) console.log(line);
    };

    let report;
    try {
      report = await runSplit({
        root,
        ...(paths.length > 0 ? { paths } : {}),
        ...(only ? { only } : {}),
        ...(baseline ? { baseline } : {}),
        write: false,
        ...(args.config ? { configFile: args.config } : {}),
        ...(args["remove-unused-directives"] ? { config: { removeUnusedDirectives: true } } : {}),
        measure: args.measure !== false,
        // Interactive review accepts changes one by one, so a later pass can't build on them.
        iterate: !args.interactive,
        onFile: (file) => {
          if (quiet || args.interactive) return;
          if (isChange(file)) {
            log(describeChange(file));
            if (!args.check) log(colorDiff(file.diff));
          } else if (file.skipped) {
            log(describeSkip(file, verbose));
          }
        },
      });
    } catch (error) {
      if (error instanceof ConfigError)
        console.error(pc.red(`auto-server-split: invalid config\n${error.message}`));
      else console.error(pc.red(`auto-server-split: ${(error as Error).stack ?? String(error)}`));
      process.exitCode = EXIT_ERROR;
      return;
    }

    let files = report.files;
    let toWrite = args.write ? files.filter(isChange) : [];
    // Interactive mode: proposed splits that weren't accepted (rejected, or left by [q]uit).
    let declined = 0;
    if (args.interactive) {
      const { reviewInteractively } = await import("./interactive.js");
      toWrite = await reviewInteractively(files, report.rerun, {
        input: process.stdin,
        output: process.stdout,
        colorDiff,
        describe: describeChange,
      });
      const acceptedByFile = new Map(toWrite.map((f) => [f.file, f]));
      declined = files.filter((f) => isChange(f) && !acceptedByFile.has(f.file)).length;
      files = files.map((f) => acceptedByFile.get(f.file) ?? f);
    }

    const splits = args.interactive ? toWrite : files.filter(isChange);
    if (toWrite.length > 0) {
      const touched = toWrite.flatMap((f) => Object.keys(f.outputs));
      if (!args["allow-dirty"]) {
        const dirty = dirtyFiles(
          root,
          touched.filter((t) => existsSync(path.join(root, t))),
        );
        if (dirty === undefined) {
          console.error(
            pc.red(
              "auto-server-split: can't read git status (not a git repository?). Commit your work or pass --allow-dirty.",
            ),
          );
          process.exitCode = EXIT_ERROR;
          return;
        }
        if (dirty.length > 0) {
          console.error(
            pc.red(
              `auto-server-split: refusing to write; these files have uncommitted changes (or aren't tracked by git):\n  ${dirty.join("\n  ")}\nCommit them or pass --allow-dirty.`,
            ),
          );
          process.exitCode = EXIT_ERROR;
          return;
        }
      }
      for (const file of toWrite) {
        for (const [rel, content] of Object.entries(file.outputs)) {
          const abs = path.join(root, rel);
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
      }
    }

    const applied = Boolean(args.write || args.interactive);
    if (format === "json") {
      console.log(JSON.stringify({ files }, null, 2));
    } else if (format === "markdown") {
      process.stdout.write(markdownReport(files, report.filesScanned, applied));
    } else {
      const mode = args.interactive
        ? "interactive"
        : args.write
          ? "write"
          : args.check
            ? "check"
            : "dry-run";
      const filesScanned = report.filesScanned;
      for (const line of summaryLines({ files, filesScanned, mode, splits, declined })) log(line);
    }
    if (format === "github") {
      const workspace = process.env.GITHUB_WORKSPACE ?? cwd;
      const repoPath = (file: string) =>
        path.relative(workspace, path.join(root, file)).split(path.sep).join("/");
      for (const line of githubAnnotations(files, repoPath)) console.log(line);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) appendFileSync(summary, markdownReport(files, report.filesScanned, applied));
    }
    if (args["write-baseline"]) {
      const listed = splits.map((f) => f.file).sort();
      writeFileSync(
        path.resolve(cwd, args["write-baseline"]),
        `${JSON.stringify({ files: listed }, null, 2)}\n`,
      );
      log(
        `\nWrote ${listed.length} file${listed.length === 1 ? "" : "s"} to ${args["write-baseline"]}. Pass --baseline ${args["write-baseline"]} to leave them as they are.`,
      );
    }

    if (files.some((f) => f.skipped?.code === "internal-error")) process.exitCode = EXIT_ERROR;
    else if (args.check && splits.length > 0) process.exitCode = EXIT_SPLITS_AVAILABLE;
    else process.exitCode = EXIT_OK;
  },
});

void runMain(main);
