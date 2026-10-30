#!/usr/bin/env node
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { evaluateCheck } from "./check.js";
import { changedFiles, dirtyFiles } from "./cli/git.js";
import { compareCommand, verifyCommand } from "./cli/subcommands.js";
import {
  colorDiff,
  describeChange,
  describeSkip,
  explanationLines,
  graphLines,
} from "./cli/text.js";
import { watchProject } from "./cli/watch.js";
import { ConfigError, findConfigFile, loadConfigFile, resolveConfig } from "./config/config.js";
import { explain } from "./explain.js";
import { boundaryGraph } from "./graph.js";
import type { Baseline } from "./report/baseline.js";
import {
  baselineOf,
  boundaryPrint,
  movedBaselineChanges,
  newBoundaryFiles,
  readBaseline,
} from "./report/baseline.js";
import { githubAnnotations } from "./report/github.js";
import { htmlReport } from "./report/html.js";
import { markdownReport } from "./report/markdown.js";
import { gitlabReport, sarifReport } from "./report/sarif.js";
import { SnapshotError, createRunContext, formatBytes, isChange, runSplit } from "./split.js";
import { acceptedRoutes, summarize, summaryLines } from "./summary.js";
import type { FileResult, RouteSaving, SplitOptions, UserConfig } from "./types.js";
import { findWorkspaceProjects, prefixResult, prefixRoutes, yarnPnpProblem } from "./workspace.js";

declare const __VERSION__: string;

const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_SPLITS_AVAILABLE = 2;

const FORMATS = ["text", "json", "markdown", "github", "sarif", "gitlab", "html"] as const;
type Format = (typeof FORMATS)[number];
/** Formats that print one report at the end instead of the per-file text. */
const REPORT_FORMATS: ReadonlySet<Format> = new Set([
  "json",
  "markdown",
  "sarif",
  "gitlab",
  "html",
]);

/** Every value of a repeatable flag (`--project a --project b`, `--project=a`); citty keeps the last. */
function repeated(rawArgs: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i] ?? "";
    if (arg === `--${name}` && rawArgs[i + 1] !== undefined) out.push(rawArgs[++i] ?? "");
    else if (arg.startsWith(`--${name}=`)) out.push(arg.slice(name.length + 3));
  }
  return out.flatMap((v) => v.split(",")).filter(Boolean);
}

const outsideRoot = (root: string, abs: string) => {
  const relative = path.relative(root, abs);
  return relative.startsWith("..") || path.isAbsolute(relative);
};

/** Why a report can't be written to `file`, checked before anything runs or is written. */
function outputProblem(file: string): string | undefined {
  const dir = path.dirname(file);
  if (existsSync(file) && statSync(file).isDirectory()) return "is a directory";
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return `its directory ${dir} does not exist`;
  try {
    accessSync(existsSync(file) ? file : dir, constants.W_OK);
  } catch {
    return "isn't writable";
  }
  return undefined;
}

const describe = (verbose: boolean) => (file: FileResult) =>
  isChange(file) ? describeChange(file) : describeSkip(file, verbose);

const main = defineCommand({
  meta: {
    name: "auto-server-split",
    version: VERSION,
    description:
      'Split partly-interactive "use client" components into a Server Component plus small client islands.\nCommands: `auto-server-split compare <before.json> <after.json>` compares two --json reports; `auto-server-split verify` runs the config\'s verify.commands (each has --help).',
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
      description: "CI mode: exit 2 if any change is available (or a budget is exceeded)",
    },
    interactive: {
      type: "boolean",
      description: "Review each proposed split ([y]es/[n]o/[r]ename/[d]iff/[q]uit)",
    },
    explain: {
      type: "string",
      description: "Explain one file: why it's client code, its islands, imports and skips",
    },
    graph: { type: "boolean", description: 'List the client boundaries ("use client" files)' },
    watch: { type: "boolean", description: "Re-analyse whenever a source file changes" },
    json: {
      type: "boolean",
      description: "Print a machine-readable report (same as --format json)",
    },
    format: {
      type: "string",
      description:
        "Output: text (default), json, markdown (for PR comments), github (text plus annotations and a job summary), sarif (code scanning), gitlab (Code Quality) or html",
    },
    output: {
      type: "string",
      description: "Write the --format report to this file and print the text output",
    },
    config: {
      type: "string",
      description: "Config file (default: auto-split.config.* in the project root)",
    },
    root: { type: "string", description: "Project root (where tsconfig.json lives; default: cwd)" },
    workspace: {
      type: "boolean",
      description: "Run on every Next.js app of the workspace (pnpm, npm, Yarn or Bun workspaces)",
    },
    project: {
      type: "string",
      description: "Run on this app (repeatable; relative to cwd); a workspace run of those apps",
    },
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
      description: "Write the available changes and their numbers to this baseline file",
    },
    "analyze-snapshot": {
      type: "string",
      description:
        "Take route sizes from a Next.js analyzer snapshot: `next analyze export` output, or the app/.next directory",
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
  async run({ args, rawArgs }) {
    const cwd = process.cwd();
    const fail = (message: string) => {
      console.error(pc.red(`auto-server-split: ${message}`));
      process.exitCode = EXIT_ERROR;
    };
    const rootArg = path.resolve(cwd, args.root ?? ".");
    if (!existsSync(rootArg)) return fail(`${args.root ?? "."} does not exist`);
    const root = realpathSync(rootArg);
    const positional = (args._ as string[]).filter(Boolean);
    for (const p of positional) {
      if (!existsSync(path.resolve(cwd, p))) return fail(`${p} does not exist`);
      if (outsideRoot(root, path.resolve(cwd, p)))
        return fail(`${p} is outside the project root (${root}); pass --root`);
    }
    const pnp = yarnPnpProblem(root);
    if (pnp) return fail(pnp);
    if (args.json && args.format !== undefined && args.format !== "json")
      return fail(`--json is --format json, so it can't be combined with --format ${args.format}`);
    const format = (args.json ? "json" : (args.format ?? "text")) as Format;
    if (!FORMATS.includes(format))
      return fail(`--format must be one of ${FORMATS.join(", ")}, got ${format}`);
    if (args.output && (format === "text" || format === "github"))
      return fail(`--output needs a report format (${[...REPORT_FORMATS].join(", ")})`);
    for (const [flag, file] of [
      ["--output", args.output],
      ["--write-baseline", args["write-baseline"]],
    ] as const) {
      const problem = file ? outputProblem(path.resolve(cwd, file)) : undefined;
      if (problem) return fail(`${flag} ${file}: ${problem}`);
    }
    const projectArgs = repeated(rawArgs, "project");
    const workspace = Boolean(args.workspace) || projectArgs.length > 0;

    // --interactive writes the splits you accept, so it can't be a dry run.
    if (args.interactive && (args["dry-run"] || args.check || REPORT_FORMATS.has(format)))
      return fail(
        "--interactive can't be combined with --dry-run, --check, --json or a report --format",
      );
    if (args.interactive && !process.stdin.isTTY) return fail("--interactive needs a terminal");
    const modes = [args["dry-run"], args.write, args.check].filter(Boolean).length;
    if (modes > 1) return fail("use only one of --dry-run, --write, --check");
    const special = [
      ["--explain", args.explain !== undefined],
      ["--graph", args.graph],
      ["--watch", args.watch],
      ["--interactive", args.interactive],
      ["--write-baseline", args["write-baseline"] !== undefined],
    ].filter(([, on]) => on);
    if (special.length > 1)
      return fail(`${special.map(([name]) => name).join(" and ")} can't be combined`);
    if ((args.explain !== undefined || args.graph || args.watch) && (args.write || args.check))
      return fail("--explain, --graph and --watch don't write or check; drop --write/--check");
    if ((args.explain !== undefined || args.graph) && format !== "text" && format !== "json")
      return fail("--explain and --graph print text or --format json");
    if ((args.explain !== undefined || args.graph) && args.output)
      return fail("--explain and --graph print to the terminal; drop --output");
    if (args.watch && format !== "text") return fail("--watch prints text only");
    if (workspace && (args.explain !== undefined || args.graph || args.watch || args.interactive))
      return fail(
        "--workspace/--project run several apps; --explain, --graph, --watch and --interactive need one (use --root)",
      );
    if (args["write-baseline"] && (args.write || args.baseline))
      return fail("--write-baseline can't be combined with --write or --baseline");
    if (args["analyze-snapshot"] && !existsSync(path.resolve(cwd, args["analyze-snapshot"])))
      return fail(`${args["analyze-snapshot"]} does not exist`);
    if (workspace && args["analyze-snapshot"])
      return fail("--analyze-snapshot describes one app; run it per app with --root");
    if (args.since?.startsWith("-")) return fail(`--since needs a git ref, got ${args.since}`);

    const verbose = Boolean(args.verbose);
    const configOverrides: UserConfig | undefined = args["remove-unused-directives"]
      ? { removeUnusedDirectives: true }
      : undefined;
    const common: SplitOptions = {
      ...(args.config ? { configFile: args.config } : {}),
      ...(configOverrides ? { config: configOverrides } : {}),
      measure: args.measure !== false,
      ...(args["analyze-snapshot"]
        ? { analyzeSnapshot: path.resolve(cwd, args["analyze-snapshot"]) }
        : {}),
    };
    const reportError = (error: unknown) => {
      if (error instanceof ConfigError) fail(`invalid config\n${error.message}`);
      else if (error instanceof SnapshotError) fail(error.message);
      else fail((error as Error).stack ?? String(error));
    };

    // ---- --explain / --graph -------------------------------------------------------------------
    if (args.explain !== undefined) {
      if (args.explain === "") return fail("--explain needs a file: --explain components/Card.tsx");
      if (positional.length > 0)
        return fail(`--explain explains one file; drop ${positional.join(" ")}`);
      const target = path.resolve(cwd, args.explain);
      if (!existsSync(target)) return fail(`${args.explain} does not exist`);
      if (statSync(target).isDirectory())
        return fail(`--explain needs a file, and ${args.explain} is a directory`);
      if (outsideRoot(root, realpathSync(target)))
        return fail(`${args.explain} is outside the project root (${root}); pass --root`);
      try {
        const explanation = await explain({
          ...common,
          root,
          file: path.relative(root, realpathSync(target)),
        });
        if (format === "json") console.log(JSON.stringify(explanation, null, 2));
        else console.log(explanationLines(explanation).join("\n"));
        process.exitCode = EXIT_OK;
      } catch (error) {
        reportError(error);
      }
      return;
    }
    if (args.graph) {
      try {
        const file = args.config ? path.resolve(root, args.config) : findConfigFile(root);
        const config = resolveConfig(
          file ? await loadConfigFile(file) : undefined,
          configOverrides,
        );
        const graph = boundaryGraph(createRunContext(root, config));
        if (format === "json") console.log(JSON.stringify(graph, null, 2));
        else console.log(graphLines(graph).join("\n"));
        process.exitCode = EXIT_OK;
      } catch (error) {
        reportError(error);
      }
      return;
    }

    // ---- projects ------------------------------------------------------------------------------
    // A workspace run is a run per app; results are relative to the workspace root.
    let projects: { dir: string; name: string }[] = [{ dir: root, name: "" }];
    if (workspace) {
      let listed: string[] | undefined;
      if (projectArgs.length > 0) {
        for (const p of projectArgs)
          if (!existsSync(path.resolve(cwd, p))) return fail(`${p} does not exist`);
        listed = projectArgs.map((p) => path.relative(root, realpathSync(path.resolve(cwd, p))));
      } else {
        try {
          const file = args.config ? path.resolve(root, args.config) : findConfigFile(root);
          const raw = file ? await loadConfigFile(file) : undefined;
          listed = raw?.projects;
        } catch (error) {
          return reportError(error);
        }
      }
      const found = findWorkspaceProjects(root, listed);
      if ("error" in found) return fail(found.error);
      if (found.projects.length === 0)
        return fail("no Next.js App Router apps found in the workspace");
      projects = found.projects;
    }
    if (workspace && positional.length > 0)
      return fail("with --workspace or --project, pass the apps with --project instead of paths");
    const paths = positional.map(
      (p) => path.relative(root, realpathSync(path.resolve(cwd, p))) || ".",
    );

    let baseline: Baseline | undefined;
    if (args.baseline) {
      const read = readBaseline(path.resolve(cwd, args.baseline));
      if ("error" in read) return fail(`can't read ${args.baseline}: ${read.error}`);
      baseline = read.baseline;
    }

    // json and the other report formats print one report at the end instead of the per-file text.
    const quiet = REPORT_FORMATS.has(format) && !args.output;
    const log = (line = "") => {
      if (!quiet) console.log(line);
    };

    const runProject = async (project: { dir: string; name: string }) => {
      const prefix = project.name ? `${project.name}/` : "";
      const only = args.since === undefined ? undefined : changedFiles(project.dir, args.since);
      if (args.since !== undefined && !only)
        throw new UsageError(
          `can't list the files changed since ${args.since} (not a git repository, an unknown ref, or a shallow clone without it?)`,
        );
      const projectBaseline = baseline?.files
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length));
      return runSplit({
        ...common,
        root: project.dir,
        ...(paths.length > 0 ? { paths } : {}),
        ...(only ? { only } : {}),
        ...(projectBaseline ? { baseline: projectBaseline } : {}),
        write: false,
        // Interactive review accepts changes one by one, so a later pass can't build on them.
        iterate: !args.interactive,
        onFile: (file) => {
          if (quiet || args.interactive || args.watch) return;
          const shown = prefixResult(file, project.name);
          if (isChange(shown)) {
            log(describeChange(shown));
            if (!args.check) log(colorDiff(shown.diff));
          } else if (shown.skipped) {
            log(describeSkip(shown, verbose));
          }
        },
      });
    };

    // ---- --watch -------------------------------------------------------------------------------
    if (args.watch) {
      const [project] = projects;
      if (!project) return;
      await watchProject({
        root: project.dir,
        run: async () => (await runProject(project)).files,
        describe: describe(verbose),
        log,
      });
      return;
    }

    let files: FileResult[] = [];
    let routes: RouteSaving[] = [];
    let filesScanned = 0;
    let rerun: Awaited<ReturnType<typeof runSplit>>["rerun"] | undefined;
    try {
      for (const project of projects) {
        if (workspace) log(pc.bold(`\n▸ ${project.name}`));
        const report = await runProject(project);
        files.push(...report.files.map((f) => prefixResult(f, project.name)));
        routes.push(...prefixRoutes(report.routes ?? [], project.name));
        filesScanned += report.filesScanned;
        rerun = report.rerun;
      }
    } catch (error) {
      if (error instanceof UsageError) return fail(error.message);
      return reportError(error);
    }

    let toWrite = args.write ? files.filter(isChange) : [];
    // Interactive mode: proposed splits that weren't accepted (rejected, or left by [q]uit).
    let declined = 0;
    if (args.interactive && rerun) {
      const { reviewInteractively } = await import("./interactive.js");
      toWrite = await reviewInteractively(files, rerun, {
        input: process.stdin,
        output: process.stdout,
        colorDiff,
        describe: describeChange,
      });
      const acceptedByFile = new Map(toWrite.map((f) => [f.file, f]));
      declined = files.filter((f) => isChange(f) && !acceptedByFile.has(f.file)).length;
      routes = acceptedRoutes(routes, toWrite);
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
        if (dirty === undefined)
          return fail(
            "can't read git status (not a git repository?). Commit your work or pass --allow-dirty.",
          );
        if (dirty.length > 0)
          return fail(
            `refusing to write; these files have uncommitted changes (or aren't tracked by git):\n  ${dirty.join("\n  ")}\nCommit them or pass --allow-dirty.`,
          );
      }
      for (const file of toWrite) {
        for (const [rel, content] of Object.entries(file.outputs)) {
          const abs = path.join(root, rel);
          mkdirSync(path.dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
      }
    }

    // ---- baseline and --check ------------------------------------------------------------------
    const exists = (f: string) => existsSync(path.join(root, f));
    const printOf = (f: string) => {
      try {
        return boundaryPrint(readFileSync(path.join(root, f), "utf8"));
      } catch {
        return undefined;
      }
    };
    const moved = baseline
      ? movedBaselineChanges(baseline, files, exists)
      : new Map<string, string>();
    const available = splits.filter((f) => !moved.has(f.file));
    let config;
    try {
      const file = args.config ? path.resolve(root, args.config) : findConfigFile(root);
      config = resolveConfig(file ? await loadConfigFile(file) : undefined);
    } catch (error) {
      return reportError(error);
    }
    if (args.check && config.check.maxNewBoundaries !== undefined && baseline?.version !== 2)
      return fail(
        baseline
          ? `check.maxNewBoundaries needs the "use client" files a baseline records; ${args.baseline} was written by an older version, so write it again with --write-baseline`
          : 'check.maxNewBoundaries compares "use client" files with a baseline: pass --baseline with a file written by --write-baseline',
      );
    const newBoundaries =
      baseline?.version === 2
        ? newBoundaryFiles(
            baseline,
            files.map((f) => f.file),
            exists,
            moved,
            printOf,
          )
        : undefined;
    const outcome = evaluateCheck(available, config.check, newBoundaries);

    // ---- output --------------------------------------------------------------------------------
    const applied = Boolean(args.write || args.interactive);
    const summary = summarize(files, filesScanned, routes);
    const repoPath = (base: string | undefined) => (file: string) =>
      path
        .relative(base ?? cwd, path.join(root, file))
        .split(path.sep)
        .join("/");
    // A baselined change that moved is left out of alerts, like one that didn't move.
    const alerting = files.filter((f) => !moved.has(f.file));
    let report: string | undefined;
    if (format === "json")
      report = `${JSON.stringify({ files, ...(routes.length > 0 ? { routes } : {}), summary }, null, 2)}\n`;
    else if (format === "markdown") report = markdownReport(files, filesScanned, applied);
    else if (format === "sarif")
      report = sarifReport(alerting, VERSION, repoPath(process.env.GITHUB_WORKSPACE));
    else if (format === "gitlab")
      report = gitlabReport(alerting, repoPath(process.env.CI_PROJECT_DIR));
    else if (format === "html")
      report = htmlReport({
        files,
        summary,
        routes,
        project: path.basename(root),
        applied,
        generatedAt: new Date(),
      });
    let outputError: string | undefined;
    if (report !== undefined) {
      if (!args.output) process.stdout.write(report);
      else
        try {
          writeFileSync(path.resolve(cwd, args.output), report);
        } catch (error) {
          outputError = `can't write ${args.output}: ${(error as Error).message}`;
        }
    }
    if (!quiet) {
      const mode = args.interactive
        ? "interactive"
        : args.write
          ? "write"
          : args.check
            ? "check"
            : "dry-run";
      for (const line of summaryLines({ files, filesScanned, mode, splits, declined, routes }))
        log(line);
      if (moved.size > 0)
        log(
          pc.dim(
            `  in the baseline under their old path: ${[...moved].map(([now, was]) => `${now} (was ${was})`).join(", ")}`,
          ),
        );
      if (args.check && outcome.failed)
        for (const reason of outcome.reasons) log(pc.red(`  ✗ ${reason}`));
      else if (args.check && available.length > 0)
        log(pc.dim("  the available changes are within the configured check thresholds"));
      if (args.output && !outputError)
        log(pc.dim(`\nWrote the ${format} report to ${args.output}.`));
    } else if (args.check && outcome.failed) {
      // The report has stdout to itself; say why the check failed on stderr.
      for (const reason of outcome.reasons) console.error(`auto-server-split: ✗ ${reason}`);
    }
    if (format === "github") {
      for (const line of githubAnnotations(alerting, repoPath(process.env.GITHUB_WORKSPACE)))
        console.log(line);
      const stepSummary = process.env.GITHUB_STEP_SUMMARY;
      if (stepSummary) appendFileSync(stepSummary, markdownReport(files, filesScanned, applied));
    }
    if (args["write-baseline"]) {
      const target = path.resolve(cwd, args["write-baseline"]);
      const previous = existsSync(target) ? readBaseline(target) : undefined;
      const next = baselineOf(
        files,
        previous && "baseline" in previous ? previous.baseline : undefined,
        printOf,
      );
      writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
      log(
        `\nWrote ${next.files.length} file${next.files.length === 1 ? "" : "s"} (${next.boundaries.length} "use client" file${next.boundaries.length === 1 ? "" : "s"}${next.totals.bytesSaved !== undefined ? `, ${formatBytes(next.totals.bytesSaved)} recoverable` : ""}) to ${args["write-baseline"]}. Pass --baseline ${args["write-baseline"]} to leave them as they are.`,
      );
    }

    if (outputError) return fail(outputError);
    if (files.some((f) => f.skipped?.code === "internal-error")) process.exitCode = EXIT_ERROR;
    else if (args.check && outcome.failed) process.exitCode = EXIT_SPLITS_AVAILABLE;
    else process.exitCode = EXIT_OK;
  },
});

/** A problem with how the CLI was called (exit 1 with the message, no stack). */
class UsageError extends Error {}

// `verify` and `compare` are subcommands; anything else is a path (write ./verify for a directory).
const argv = process.argv.slice(2);
if (argv[0] === "verify") void runMain(verifyCommand, { rawArgs: argv.slice(1) });
else if (argv[0] === "compare") void runMain(compareCommand, { rawArgs: argv.slice(1) });
else void runMain(main, { rawArgs: argv });
