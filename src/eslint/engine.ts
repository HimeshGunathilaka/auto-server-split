import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Outcome } from "../analysis/skip.js";
import { findConfigFile, loadConfigFileSync, resolveConfig } from "../config/config.js";
import { BundleMeasurer } from "../measure/bundleSize.js";
import { ensureLoaded, setSourceText } from "../project/loadProject.js";
import type { Analyzed, RunContext } from "../split.js";
import { analyzeFile, checkAnalyzed, createRunContext, measureAnalyzed } from "../split.js";
import type { UserConfig } from "../types.js";

type LintOptions = {
  /** Report only when at least this share of the JSX stays on the server (default 0.5). */
  minStaticRatio?: number;
  /** Run the in-memory self-check before reporting (default true). */
  selfCheck?: boolean;
  /** Measure the saving with esbuild and apply `minBytesSaved` (default true). */
  measure?: boolean;
};

/** The rule's own default: lint reports clear wins only. The config's threshold always applies too. */
const DEFAULT_MIN_STATIC_RATIO = 0.5;

/** One cached run per tsconfig, mode and threshold, for the lifetime of the lint process. */
const runs = new Map<string, RunContext>();
/** The project's auto-split config, read once per project root. */
const configs = new Map<string, UserConfig | undefined>();

function findTsconfig(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The config file the CLI would load for this root, any format (invalid configs throw). */
function projectConfig(root: string): UserConfig | undefined {
  if (!configs.has(root)) {
    const file = findConfigFile(root);
    configs.set(root, file ? loadConfigFileSync(file) : undefined);
  }
  return configs.get(root);
}

function importerClosure(run: RunContext, file: string): string[] {
  const out = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const target = queue.shift() as string;
    for (const edge of run.graph.importersOf(target)) {
      if (edge.kind === "type" || out.has(edge.from)) continue;
      out.add(edge.from);
      if (edge.kind === "reexport") queue.push(edge.from);
    }
  }
  return [...out];
}

/**
 * Runs the core engine for one linted file. `typed` (parserServices.program present) loads the
 * whole project; otherwise a lazy project loads only this file, what it imports, and its importers.
 * Applies the same config, self-check and size threshold as the CLI, so it only reports files the
 * CLI would split. Returns undefined when the file can't be analysed or verified.
 */
export function analyzeForLint(args: {
  file: string;
  text: string;
  typed: boolean;
  tsconfig: string | undefined;
  options: LintOptions;
}): Outcome<Analyzed> | undefined {
  const found = args.tsconfig ?? findTsconfig(args.file);
  if (!found || !existsSync(found)) return undefined;
  const tsconfig = realpathSync(found);
  const file = realpathSync(args.file);
  const root = path.dirname(tsconfig);
  const fileConfig = projectConfig(root);
  // The rule option can raise the bar, never lower it below what the CLI applies.
  const minStaticRatio = Math.max(
    args.options.minStaticRatio ?? DEFAULT_MIN_STATIC_RATIO,
    resolveConfig(fileConfig).minStaticRatio,
  );
  const key = `${args.typed ? "typed" : "lazy"}\0${tsconfig}\0${minStaticRatio}`;
  let run = runs.get(key);
  if (!run) {
    const config = resolveConfig(fileConfig, { minStaticRatio, prettier: false });
    run = createRunContext(root, config, { lazy: !args.typed, tsconfig });
    runs.set(key, run);
  }
  const node = run.graph.nodes.get(file);
  if (!node?.inProgram) return undefined; // not covered by the tsconfig: importers can't be verified

  if (!args.typed) ensureLoaded(run.loaded, [file, ...importerClosure(run, file)]);
  const sf = run.loaded.project.getSourceFile(file);
  if (!sf) return undefined;
  // Analyse what the editor/CLI is linting, not what's on disk.
  if (sf.getFullText() !== args.text) setSourceText(sf, args.text);

  const analyzed = analyzeFile(run, file);
  if (!analyzed.ok) return analyzed;
  if (args.options.selfCheck !== false) {
    const checked = checkAnalyzed(run, analyzed.value);
    if (!checked.ok) return checked;
  }
  if (args.options.measure !== false) {
    run.measurer ??= new BundleMeasurer(root, run.graph, run.loaded.configFile);
    const saving = measureAnalyzed(run, analyzed.value);
    if (!saving.ok) return saving;
  }
  return analyzed;
}

/** For tests: forget cached projects and configs. */
export function clearLintCache(): void {
  runs.clear();
  configs.clear();
}
