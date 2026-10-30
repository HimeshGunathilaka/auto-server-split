import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import pc from "picocolors";
import { ConfigError, findConfigFile, loadConfigFile, resolveConfig } from "../config/config.js";
import { compareReports, comparisonLines, readReport } from "../report/compare.js";
import { runVerification } from "../verify/commands.js";

const EXIT_ERROR = 1;

const fail = (message: string) => {
  console.error(pc.red(`auto-server-split: ${message}`));
  process.exitCode = EXIT_ERROR;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** `auto-server-split verify`: runs the config's `verify.commands` and reports what passed. */
export const verifyCommand = defineCommand({
  meta: {
    name: "verify",
    description:
      "Run the config's verify.commands (type checker, tests, build) after applying changes, and report the result",
  },
  args: {
    root: { type: "string", description: "Project root (default: cwd)" },
    config: {
      type: "string",
      description: "Config file (default: auto-split.config.* in the root)",
    },
    json: { type: "boolean", description: "Print the result as JSON (output is captured)" },
    "keep-going": { type: "boolean", description: "Run every command even after one fails" },
    report: {
      type: "string",
      description: "Add the result to this JSON report (written with --json --output)",
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const root = path.resolve(cwd, args.root ?? ".");
    if (!existsSync(root)) return fail(`${args.root ?? "."} does not exist`);
    let commands: string[];
    try {
      const file = args.config ? path.resolve(root, args.config) : findConfigFile(root);
      commands = resolveConfig(file ? await loadConfigFile(file) : undefined).verify.commands;
    } catch (error) {
      if (error instanceof ConfigError) return fail(`invalid config\n${error.message}`);
      throw error;
    }
    if (commands.length === 0)
      return fail(
        'no commands to run: add verify: { commands: ["pnpm typecheck", "pnpm test", "pnpm build"] } to the config',
      );
    // Checked first: the commands can take minutes (a build), and the result would be lost.
    const reportFile = args.report ? path.resolve(cwd, args.report) : undefined;
    const existing = reportFile ? readReport(reportFile) : undefined;
    if (existing && "error" in existing)
      return fail(`can't read ${args.report}: ${existing.error}`);
    const json = Boolean(args.json);
    const verification = await runVerification(commands, realpathSync(root), {
      // A report keeps each command's output tail, so capture it (and still show it).
      capture: json || Boolean(reportFile),
      echo: !json,
      keepGoing: Boolean(args["keep-going"]),
      onStart: (command) => {
        if (!json) console.log(pc.bold(`\n▶ ${command}`));
      },
    });
    if (reportFile && existing && "report" in existing)
      try {
        writeFileSync(
          reportFile,
          `${JSON.stringify({ ...existing.report, verification }, null, 2)}\n`,
        );
      } catch (error) {
        return fail(`can't write ${args.report}: ${(error as Error).message}`);
      }
    if (json) console.log(JSON.stringify(verification, null, 2));
    else {
      console.log(`\n${pc.bold("Verification")}`);
      for (const step of verification.steps) {
        const ok = step.exitCode === 0;
        const status = ok ? pc.green("✔") : pc.red(`✗ exited with ${step.exitCode ?? "a signal"}:`);
        console.log(`  ${status} ${step.command} ${pc.dim(`(${seconds(step.durationMs)})`)}`);
      }
      for (const command of verification.notRun)
        console.log(`  ${pc.dim(`– not run: ${command}`)}`);
      if (args.report) console.log(pc.dim(`\nAdded to ${args.report}.`));
    }
    process.exitCode = verification.passed ? 0 : EXIT_ERROR;
  },
});

/** `auto-server-split compare`: what changed between two JSON reports. */
export const compareCommand = defineCommand({
  meta: {
    name: "compare",
    description:
      "Compare two JSON reports (--json) of the same project: new opportunities, savings",
  },
  args: {
    before: { type: "positional", required: true, description: "The earlier report" },
    after: { type: "positional", required: true, description: "The later report" },
    format: { type: "string", description: "text (default), json or markdown" },
    "fail-on-new": {
      type: "boolean",
      description: "Exit 2 when the later report has opportunities the earlier one doesn't",
    },
  },
  run({ args }) {
    const format = args.format ?? "text";
    if (!["text", "json", "markdown"].includes(format))
      return fail(`--format must be text, json or markdown, got ${format}`);
    const reports = [args.before, args.after].map((f) => ({ f, read: readReport(f) }));
    for (const { f, read } of reports)
      if ("error" in read) return fail(`can't read ${f}: ${read.error}`);
    const [before, after] = reports.map(({ read }) => ("report" in read ? read.report : undefined));
    if (!before || !after) return;
    const comparison = compareReports(before, after);
    if (format === "json") console.log(JSON.stringify(comparison, null, 2));
    else console.log(comparisonLines(comparison, format === "markdown").join("\n"));
    process.exitCode = args["fail-on-new"] && comparison.added.length > 0 ? 2 : 0;
  },
});
