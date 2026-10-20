#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { SKIP_TITLES } from "./analysis/skip.js";
import { ConfigError } from "./config/config.js";
import { formatBytes, runSplit } from "./split.js";
import type { FileResult, SkipCode } from "./types.js";

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

function describeSplit(file: FileResult): string {
  const islands = file.islands.map(
    (i) => `${i.name} <${i.rootTag}>${i.props.length ? ` (props: ${i.props.join(", ")})` : ""}`,
  );
  const saved = file.bytesSaved
    ? ` · ~${formatBytes(file.bytesSaved.conservative)} gzip saved (estimated)`
    : file.measureError
      ? ` · ${pc.yellow("saving not measured")} (${file.measureError})`
      : "";
  return `${pc.green("✔ split")} ${pc.bold(file.file)} · ${file.islands.length} island${file.islands.length === 1 ? "" : "s"} · ${Math.round(file.staticRatio * 100)}% static${saved}\n    ${islands.join("\n    ")}`;
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
      ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...files],
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
      description: "CI mode: exit 2 if any split is available, change nothing",
    },
    interactive: {
      type: "boolean",
      description: "Review each proposed split ([y]es/[n]o/[r]ename/[d]iff/[q]uit)",
    },
    json: { type: "boolean", description: "Print a machine-readable report" },
    config: {
      type: "string",
      description: "Config file (default: auto-split.config.* in the project root)",
    },
    root: { type: "string", description: "Project root (where tsconfig.json lives; default: cwd)" },
    "allow-dirty": {
      type: "boolean",
      description: "Allow --write on files with uncommitted git changes",
    },
    verbose: { type: "boolean", description: "Show stack traces for internal errors" },
    measure: {
      type: "boolean",
      default: true,
      description: "Measure bundle sizes with esbuild (--no-measure to skip)",
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
    // --interactive writes the splits you accept, so it can't be a dry run.
    if (args.interactive && (args["dry-run"] || args.json || args.check)) {
      console.error(
        pc.red(
          "auto-server-split: --interactive can't be combined with --dry-run, --json or --check",
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
    const verbose = Boolean(args.verbose);
    const json = Boolean(args.json);
    const log = (line = "") => {
      if (!json) console.log(line);
    };

    let report;
    try {
      report = await runSplit({
        root,
        ...(paths.length > 0 ? { paths } : {}),
        write: false,
        ...(args.config ? { configFile: args.config } : {}),
        measure: args.measure !== false,
        onFile: (file) => {
          if (json || args.interactive) return;
          if (file.status === "split") {
            log(describeSplit(file));
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
    let toWrite = args.write ? files.filter((f) => f.status === "split") : [];
    if (args.interactive) {
      const { reviewInteractively } = await import("./interactive.js");
      toWrite = await reviewInteractively(files, report.rerun, {
        input: process.stdin,
        output: process.stdout,
        colorDiff,
        describe: describeSplit,
      });
      const acceptedByFile = new Map(toWrite.map((f) => [f.file, f]));
      files = files.map((f) => acceptedByFile.get(f.file) ?? f);
    }

    const splits = files.filter((f) => f.status === "split");
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

    if (json) {
      console.log(JSON.stringify({ files }, null, 2));
    } else {
      const skipped = files.filter((f) => f.status === "skipped");
      const byCode = new Map<SkipCode, number>();
      for (const f of skipped)
        if (f.skipped) byCode.set(f.skipped.code, (byCode.get(f.skipped.code) ?? 0) + 1);
      const saved = splits.reduce((n, f) => n + (f.bytesSaved?.conservative ?? 0), 0);
      log();
      log(pc.bold("Summary"));
      log(`  files scanned:  ${report.filesScanned} (${files.length} with "use client")`);
      const written = Boolean(args.write || args.interactive);
      const writeNote = written
        ? ` (${toWrite.length} written)`
        : args.check
          ? ""
          : " (dry run, nothing written)";
      log(`  files split:    ${splits.length}${writeNote}`);
      log(`  files skipped:  ${skipped.length}`);
      for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
        log(`    ${String(count).padStart(3)}  ${code.padEnd(30)} ${pc.dim(SKIP_TITLES[code])}`);
      }
      const unmeasured = splits.filter((f) => f.measureError).length;
      const unmeasuredNote =
        unmeasured > 0 ? ` (${unmeasured} split${unmeasured === 1 ? "" : "s"} not measured)` : "";
      if (report.files.some((f) => f.bytesSaved))
        log(`  estimated saving: ${formatBytes(saved)} gzip of client JavaScript${unmeasuredNote}`);
      else if (unmeasured > 0) log(`  estimated saving: unknown${unmeasuredNote}`);
      if (!written && !args.check && splits.length > 0)
        log(pc.dim("\nRun again with --write to apply."));
    }

    if (files.some((f) => f.skipped?.code === "internal-error")) process.exitCode = EXIT_ERROR;
    else if (args.check && splits.length > 0) process.exitCode = EXIT_SPLITS_AVAILABLE;
    else process.exitCode = EXIT_OK;
  },
});

void runMain(main);
