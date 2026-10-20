import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Outcome } from "../analysis/skip.js";
import { ConfigError, resolveConfig, validateConfig } from "../config/config.js";
import { ensureLoaded } from "../project/loadProject.js";
import type { Analyzed, RunContext } from "../split.js";
import { analyzeFile, checkAnalyzed, createRunContext } from "../split.js";
import type { UserConfig } from "../types.js";

type LintOptions = {
  minStaticRatio?: number;
  /** Run the in-memory self-check before reporting (default true). */
  selfCheck?: boolean;
};

/** One cached run per tsconfig and mode, for the lifetime of the lint process. */
const runs = new Map<string, RunContext>();

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

function readJsonConfig(root: string): UserConfig | undefined {
  // ESLint rules are synchronous, so only the JSON config file is read here.
  const file = path.join(root, "auto-split.config.json");
  if (!existsSync(file)) return undefined;
  try {
    return validateConfig(JSON.parse(readFileSync(file, "utf8")), "auto-split.config.json");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return undefined;
  }
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
 * Returns undefined when the file can't be analysed or verified.
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
  const minStaticRatio = args.options.minStaticRatio ?? 0.5;
  const key = `${args.typed ? "typed" : "lazy"}\0${tsconfig}\0${minStaticRatio}`;
  let run = runs.get(key);
  if (!run) {
    const config = resolveConfig(readJsonConfig(root), { minStaticRatio, prettier: false });
    run = createRunContext(root, config, { lazy: !args.typed, tsconfig });
    runs.set(key, run);
  }
  const node = run.graph.nodes.get(file);
  if (!node?.inProgram) return undefined; // not covered by the tsconfig: importers can't be verified

  if (!args.typed) ensureLoaded(run.loaded, [file, ...importerClosure(run, file)]);
  const sf = run.loaded.project.getSourceFile(file);
  if (!sf) return undefined;
  // Analyse what the editor/CLI is linting, not what's on disk.
  if (sf.getFullText() !== args.text) sf.replaceWithText(args.text);

  const analyzed = analyzeFile(run, file);
  if (!analyzed.ok || args.options.selfCheck === false) return analyzed;
  const checked = checkAnalyzed(run, analyzed.value);
  return checked.ok ? analyzed : checked;
}

/** For tests: forget cached projects. */
export function clearLintCache(): void {
  runs.clear();
}
