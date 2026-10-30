import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import fg from "fast-glob";
import { ts } from "ts-morph";
import { analyzeFileShape, wrapperCalleeHeads } from "./analysis/components.js";
import { findIgnoreComment, findIgnoreCommentOutsideHeader } from "./analysis/directives.js";
import type { Warning } from "./analysis/warnings.js";
import { findTimezoneWarnings } from "./analysis/timezone.js";
import type { AnalysisContext } from "./analysis/context.js";
import { lineCol, locOf } from "./analysis/context.js";
import type { FrameworkAdapter } from "./analysis/framework.js";
import { buildImportTable } from "./analysis/importTable.js";
import { checkImporters } from "./analysis/importers.js";
import type { ComponentInfo } from "./analysis/components.js";
import type { ComponentPlan, PlanTrace } from "./analysis/islands.js";
import { planComponent, unitNodes } from "./analysis/islands.js";
import { tagNameText } from "./analysis/refs.js";
import { ModuleSafety } from "./analysis/moduleSafety.js";
import { findRuleWarnings } from "./analysis/ruleWarnings.js";
import { SafetyRules } from "./analysis/rules.js";
import type { Outcome, Skip } from "./analysis/skip.js";
import { ok, skip } from "./analysis/skip.js";
import { FileFacts, findEnvProblem } from "./analysis/taint.js";
import {
  ConfigError,
  findConfigFile,
  loadConfigFile,
  resolveConfig,
  validateConfig,
} from "./config/config.js";
import {
  couldBecomeRoute,
  findAppRoutes,
  nextAdapter,
  readPageExtensions,
} from "./frameworks/next.js";
import { yarnPnpProblem } from "./workspace.js";
import type { BundleMeasurer, Measurement, SplitCandidate } from "./measure/bundleSize.js";
import type { AnalyzerSnapshot } from "./measure/nextAnalyze.js";
import { readAnalyzerSnapshot } from "./measure/nextAnalyze.js";
import type { FileRoute } from "./measure/routes.js";
import { routeSavings } from "./measure/routes.js";
import type { LoadedProject } from "./project/loadProject.js";
import { IGNORE_GLOBS, loadProject, setSourceText } from "./project/loadProject.js";
import type { ModuleGraph } from "./project/moduleGraph.js";
import { buildModuleGraph } from "./project/moduleGraph.js";
import { PackageClassifier } from "./project/packages.js";
import { emitDirectiveRemoval, emitSplit } from "./transform/emit.js";
import { projectFormatter } from "./transform/format.js";
import { hasMixedLineEndings, lineEndingOf, withLineEnding } from "./transform/text.js";
import type { FileResult, IslandInfo, ResolvedConfig, SplitOptions, SplitResult } from "./types.js";
import { summarize } from "./summary.js";
import { selfCheck } from "./verify/selfCheck.js";

const STYLESHEET_RE = /\.(css|scss|sass|less|styl|pcss)$/;

/** An analyzer snapshot (`analyzeSnapshot`) that can't be read. */
export class SnapshotError extends Error {}

export type RunContext = {
  root: string;
  config: ResolvedConfig;
  framework: FrameworkAdapter;
  loaded: LoadedProject;
  graph: ModuleGraph;
  classifier: PackageClassifier;
  moduleSafety: ModuleSafety;
  serverSafeHooks: ReadonlySet<string>;
  /** The config's `rules`, compiled. */
  rules: SafetyRules;
  pageExtensions: ReturnType<typeof readPageExtensions>;
  measurer: BundleMeasurer | undefined;
  /** The splits the run's size estimates assume (see estimateSavings), once computed. */
  estimate?: SavingsEstimate;
  /** Files left as they are (a `--check` baseline): never targets, never assumed split. */
  baseline?: ReadonlySet<string>;
};

type Saving = Pick<FileResult, "bytesSaved" | "measureError">;

/** A split that passed analysis, formatting and the self-check; its saving comes later. */
type Planned = {
  outputs: Record<string, string>;
  islands: IslandInfo[];
  staticRatio: number;
  originalText: string;
  candidate: SplitCandidate;
  warnings: Warning[];
  componentName: string;
  componentSource: string;
};

/** Builds the shared state for one run: project, module graph, classifiers. Synchronous. */
export function createRunContext(
  root: string,
  config: ResolvedConfig,
  options: { lazy?: boolean; tsconfig?: string } = {},
): RunContext {
  const loaded = loadProject(root, {
    lazy: options.lazy ?? false,
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
  });
  return contextFor(root, config, loaded);
}

function contextFor(root: string, config: ResolvedConfig, loaded: LoadedProject): RunContext {
  const framework = nextAdapter;
  const rules = new SafetyRules(config.rules);
  const classifier = new PackageClassifier(
    framework,
    [...config.clientOnlyPackages, ...rules.clientOnlyPackages],
    [...config.serverSafePackages, ...rules.serverSafePackages],
  );
  const graph = buildModuleGraph(loaded, classifier);
  const serverSafeHooks = new Set(config.serverSafeHooks);
  const moduleSafety = new ModuleSafety(
    () => loaded.project.getProgram().compilerObject,
    graph,
    framework,
    serverSafeHooks,
    rules,
  );
  return {
    root,
    config,
    framework,
    loaded,
    graph,
    classifier,
    moduleSafety,
    serverSafeHooks,
    rules,
    pageExtensions: readPageExtensions(root),
    measurer: undefined,
  };
}

/** Passes a run makes at most when changes make other files changeable (see `iterate`). */
const MAX_PASSES = 10;

/** Whether a result changes files: a split, or a removed directive. */
export function isChange(result: FileResult): boolean {
  return result.status === "split" || result.status === "directive-removed";
}

/**
 * Options of a run. `trace`: the planning decisions for one file, as of the last pass that
 * analysed it, are put in `components` (per component name); the file is targeted even when
 * `paths` and `include` don't cover it.
 */
export type RunOptions = SplitOptions & {
  trace?: { file: string; components: Map<string, PlanTrace> };
};

const OPTION_TYPES: Record<string, "string" | "strings" | "boolean" | "object" | "function"> = {
  root: "string",
  paths: "strings",
  only: "strings",
  baseline: "strings",
  write: "boolean",
  config: "object",
  configFile: "string",
  noConfigFile: "boolean",
  measure: "boolean",
  iterate: "boolean",
  onFile: "function",
  routes: "boolean",
  analyzeSnapshot: "string",
  // explain()'s own options, passed through.
  file: "string",
  trace: "object",
};

/** Rejects options a caller got wrong (an unknown key, `paths: "x"`) instead of guessing. */
function validateOptions(options: RunOptions, root: string): void {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    const type = OPTION_TYPES[key];
    if (value === undefined) continue;
    if (!type) {
      problems.push(`unknown option "${key}"`);
      continue;
    }
    const ok =
      type === "strings"
        ? Array.isArray(value) && value.every((v) => typeof v === "string")
        : type === "object"
          ? typeof value === "object" && value !== null && !Array.isArray(value)
          : typeof value === type;
    if (!ok)
      problems.push(`${key} must be ${type === "strings" ? "an array of strings" : `a ${type}`}`);
  }
  for (const key of ["paths", "only", "baseline"] as const) {
    const value = options[key];
    if (!Array.isArray(value)) continue;
    for (const p of value) {
      const relative = path.relative(root, path.resolve(root, p));
      if (relative.startsWith("..") || path.isAbsolute(relative))
        problems.push(`${key}: ${p} is outside the root (${root})`);
    }
  }
  if (problems.length > 0) throw new ConfigError(`split(): ${problems.join("; ")}`);
}

export async function runSplit(options: RunOptions = {}): Promise<
  SplitResult & {
    filesScanned: number;
    /** The run's context as of the first pass (its module graph describes the project on disk). */
    run: RunContext;
    /**
     * Re-runs one file with island renames (interactive mode). Only for single-pass runs
     * (`iterate: false`): later passes change the project the first pass analysed.
     */
    rerun: (relFile: string, renames: Readonly<Record<string, string>>) => Promise<FileResult>;
  }
> {
  if (typeof options !== "object" || options === null)
    throw new ConfigError("split(): options must be an object");
  const rootArg = path.resolve(typeof options.root === "string" ? options.root : process.cwd());
  if (!existsSync(rootArg)) throw new ConfigError(`split(): root ${rootArg} does not exist`);
  // Real path: TypeScript resolves symlinks (e.g. macOS /var -> /private/var), so globbed paths must too.
  const root = realpathSync(rootArg);
  validateOptions(options, root);
  const pnp = yarnPnpProblem(root);
  if (pnp) throw new Error(pnp);
  const configFile = options.noConfigFile
    ? undefined
    : options.configFile
      ? path.resolve(root, options.configFile)
      : findConfigFile(root);
  if (configFile && !existsSync(configFile))
    throw new ConfigError(`split(): the config file ${options.configFile} does not exist`);
  const fileConfig = configFile ? await loadConfigFile(configFile) : undefined;
  const overrides = options.config
    ? validateConfig(options.config, "split({ config })")
    : undefined;
  const config = resolveConfig(fileConfig, overrides);
  const iterate = options.iterate !== false;
  let snapshot: AnalyzerSnapshot | undefined;
  if (options.analyzeSnapshot) {
    const read = readAnalyzerSnapshot(root, options.analyzeSnapshot);
    if ("error" in read)
      throw new SnapshotError(
        `can't read the analyzer snapshot ${options.analyzeSnapshot}: ${read.error}`,
      );
    // Module keys are project paths (or package names): a snapshot of another app has none here.
    const files = [...read.routes.values()].flatMap((r) =>
      [...r.initial.keys(), ...r.lazy.keys()].filter((k) => /\.[cm]?[jt]sx?$/.test(k)),
    );
    if (files.length > 0 && !files.some((k) => existsSync(path.join(root, k))))
      throw new SnapshotError(
        `the analyzer snapshot ${options.analyzeSnapshot} describes another project: none of its ${new Set(files).size} source files are in ${root}`,
      );
    snapshot = read;
  }

  const run = createRunContext(root, config);
  if (options.baseline) run.baseline = new Set(options.baseline.map((f) => path.resolve(root, f)));
  const Measurer =
    options.measure === false
      ? undefined
      : (await import("./measure/bundleSize.js")).BundleMeasurer;
  if (Measurer) run.measurer = new Measurer(root, run.graph, run.loaded.configFile);

  const only = options.only && new Set(options.only.map((f) => path.resolve(root, f)));
  const targets = selectTargets(root, options.paths, config, run.baseline).filter(
    (file) => !only || only.has(file),
  );
  const traceFile = options.trace && path.resolve(root, options.trace.file);
  if (
    traceFile &&
    !targets.includes(traceFile) &&
    run.graph.nodes.has(traceFile) &&
    !isIslandFile(traceFile, config)
  )
    targets.push(traceFile);
  const results = new Map<string, FileResult>();
  const report = (file: string, result: FileResult) => {
    results.set(file, result);
    options.onFile?.(result);
  };

  // A file imported by a client module may become changeable once that importer is split (or loses
  // its directive), so with `iterate` its skip is held back and the file is analysed again in a
  // pass that sees the earlier changes. Passes only plan: a change's saving depends on the others,
  // including the ones later passes find, so thresholds are applied once every pass is done.
  const held = new Map<string, FileResult>();
  const planned = new Map<string, { ctx: RunContext; value: Planned }>();
  /** Files planned in a later pass, with the imported-by-client skip they had before it. */
  const unblocked = new Map<string, FileResult>();
  let extras: SplitCandidate[] | undefined;
  // The other "use client" files in `include` are analysed as they are on disk, before a pass
  // changes the project in memory.
  const extraCandidatesOnce = () => (extras ??= extraCandidates(run, new Set(targets)));
  let ctx = run;
  let files = targets.filter((file) => run.graph.nodes.get(file)?.directive === "use client");
  let passes = 0;
  while (files.length > 0) {
    passes++;
    const changed: Planned[] = [];
    for (const file of files) {
      const traces = file === traceFile ? options.trace?.components : undefined;
      traces?.clear();
      const outcome = await planSafely(ctx, file, {}, traces);
      if (outcome.ok) {
        const before = held.get(file);
        if (before) unblocked.set(file, before);
        held.delete(file);
        planned.set(file, { ctx, value: outcome.value });
        changed.push(outcome.value);
      } else if (iterate && outcome.skip.code === "imported-by-client") {
        held.set(file, skippedResult(ctx, file, outcome.skip));
      } else {
        held.delete(file);
        report(file, skippedResult(ctx, file, outcome.skip));
      }
    }
    if (!iterate || changed.length === 0 || held.size === 0 || passes >= MAX_PASSES) break;
    if (run.measurer) extraCandidatesOnce();
    const outputs = new Map(
      changed.flatMap((p) =>
        Object.entries(p.outputs).map(
          ([relPath, text]) => [path.join(root, relPath), text] as const,
        ),
      ),
    );
    ctx = nextPassContext(ctx, outputs);
    files = [...held.keys()];
  }

  // A change found in a later pass needs the earlier changes that made its importers Server
  // Components: the "use client" files above it in the original module graph.
  const requires = new Map<string, string[]>();
  for (const file of unblocked.keys()) {
    requires.set(
      file,
      [...run.graph.clientRootsAbove(file)].filter((f) => planned.has(f)),
    );
  }
  if (run.measurer && planned.size > 0) {
    run.estimate = estimateSavings(
      run,
      [...planned.values()].map((p) => p.value.candidate),
      new Set(targets),
      { extras: extraCandidatesOnce(), requires },
    );
  }
  const kept = run.estimate?.kept ?? new Set(planned.keys());
  // Which routes each change affects, and what it saves there.
  const appRoutes =
    options.routes === false || !run.pageExtensions.ok
      ? []
      : findAppRoutes(root, run.pageExtensions.extensions);
  const routes =
    appRoutes.length > 0 && kept.size > 0
      ? routeSavings({
          root,
          graph: run.graph,
          routes: appRoutes,
          changes:
            run.estimate?.candidates ??
            [...planned.values()].map((p) => p.value.candidate).filter((c) => kept.has(c.file)),
          reported: new Set([...planned.keys()].filter((f) => kept.has(f))),
          measurer: run.measurer,
          snapshot,
        })
      : undefined;
  const allRequired = (file: string): string[] => {
    const out = new Set<string>();
    const pending = [...(requires.get(file) ?? [])];
    for (let r = pending.pop(); r; r = pending.pop()) {
      if (out.has(r)) continue;
      out.add(r);
      pending.push(...(requires.get(r) ?? []));
    }
    return [...out].map((f) => rel(root, f)).sort();
  };
  // Planned in pass order, so a file's requirements are reported before it.
  for (const [file, { ctx: fileCtx, value }] of planned) {
    const missing = (requires.get(file) ?? []).filter((r) => !kept.has(r));
    const before = unblocked.get(file);
    if (missing.length > 0 && before?.skipped) {
      const why = missing
        .map((r) => {
          const code = results.get(r)?.skipped?.code;
          return `${rel(root, r)}${code ? ` (skipped: ${code})` : ""}`;
        })
        .join(", ");
      report(file, {
        ...before,
        skipped: {
          ...before.skipped,
          message: `${before.skipped.message}; it can be split along with ${why}, which isn't changed`,
        },
      });
      continue;
    }
    const saving = run.estimate ? run.estimate.outcome(value.candidate) : ok({});
    report(
      file,
      saving.ok
        ? changeResult(
            fileCtx,
            file,
            value,
            saving.value,
            allRequired(file),
            routes?.files.get(file),
          )
        : skippedResult(fileCtx, file, saving.skip),
    );
  }
  for (const [file, result] of held) report(file, result);
  const allFiles = targets.flatMap((file) => results.get(file) ?? []);

  if (options.write) {
    for (const result of allFiles) {
      if (!isChange(result)) continue;
      for (const [relPath, content] of Object.entries(result.outputs)) {
        const abs = path.join(root, relPath);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
  }
  return {
    files: allFiles,
    ...(routes ? { routes: routes.routes } : {}),
    summary: summarize(allFiles, targets.length, routes?.routes),
    filesScanned: targets.length,
    run,
    rerun: async (relFile, renames) => {
      if (passes > 1) throw new Error("rerun() needs a single-pass run (iterate: false)");
      const file = path.resolve(root, relFile);
      const outcome = await planSafely(run, file, renames);
      if (!outcome.ok) return skippedResult(run, file, outcome.skip);
      const saving = run.estimate?.outcome(outcome.value.candidate) ?? ok({});
      return saving.ok
        ? changeResult(run, file, outcome.value, saving.value)
        : skippedResult(run, file, saving.skip);
    },
  };
}

/**
 * The context for another pass: `outputs` (absolute path -> text, the last pass's changes) are
 * applied to the project in memory, and the module graph and classifiers are rebuilt on top. The
 * earlier contexts share the project, so they no longer describe the files on disk; only their
 * module graphs (and the first context's measurer, which bundles from disk) still do.
 */
function nextPassContext(run: RunContext, outputs: ReadonlyMap<string, string>): RunContext {
  const { loaded } = run;
  for (const [file, text] of outputs) {
    const sf = loaded.project.getSourceFile(file);
    if (sf) setSourceText(sf, text);
    else loaded.project.createSourceFile(file, text);
  }
  loaded.overlay = new Map([...(loaded.overlay ?? []), ...outputs]);
  return { ...contextFor(run.root, run.config, loaded), baseline: run.baseline };
}

/** The "use client" files a run targets: `paths`, or the config's `include` globs. */
function selectTargets(
  root: string,
  paths: string[] | undefined,
  config: ResolvedConfig,
  baseline: ReadonlySet<string> = new Set(),
): string[] {
  const ignore = [...IGNORE_GLOBS, ...config.exclude];
  const sourceGlob = "**/*.{tsx,jsx,ts,js,mts,mjs}";
  let files: string[];
  if (paths && paths.length > 0) {
    files = [];
    for (const p of paths) {
      const abs = path.resolve(root, p);
      if (!existsSync(abs)) continue;
      if (/\.(tsx|jsx|ts|js|mts|mjs)$/.test(abs) && !abs.endsWith(".d.ts")) files.push(abs);
      else
        files.push(
          ...fg.sync([sourceGlob], { cwd: abs, ignore: [...ignore, "**/*.d.ts"], absolute: true }),
        );
    }
  } else {
    files = fg.sync(
      config.include.map((g) => (g.endsWith("/**") ? `${g}/*` : g)),
      { cwd: root, ignore: [...ignore, "**/*.d.ts"], absolute: true },
    );
  }
  return [...new Set(files.map((f) => path.resolve(f)))]
    .filter(
      (f) => /\.(tsx|jsx|ts|js|mts|mjs)$/.test(f) && !isIslandFile(f, config) && !baseline.has(f),
    )
    .sort();
}

/**
 * Identifies a change across runs without its path or line numbers: the kind of change, the main
 * component, its islands' names and its components' source (whitespace aside). A baseline entry
 * still matches after the file moves or other code shifts it; it stops matching when the islands
 * or the components change.
 */
export function changeFingerprint(
  status: FileResult["status"],
  componentName: string,
  islands: readonly IslandInfo[],
  componentSource = "",
): string {
  const names = islands.map((i) => `${i.name}<${i.rootTag}>`).sort();
  return createHash("sha256")
    .update([status, componentName, ...names, componentSource].join("\0"))
    .digest("hex")
    .slice(0, 16);
}

/** Alternate island names tried after `X.client.tsx` with `outputExists: "alternate"`. */
const ALTERNATE_ISLAND_NAMES = 3;

/**
 * The island file for `file`: `X.client.tsx`, or with `outputExists: "alternate"` the first free
 * one of `X.island.client.tsx`, `X.island2.client.tsx`... Never a file that `exists`; otherwise
 * `taken` lists the names tried.
 */
function islandFileFor(
  file: string,
  dir: string,
  config: ResolvedConfig,
  exists: (file: string) => boolean,
): { ok: true; file: string } | { ok: false; taken: string[] } {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const names = [`${base}${config.clientFileSuffix}${ext}`];
  if (config.outputExists === "alternate") {
    for (let n = 1; n <= ALTERNATE_ISLAND_NAMES; n++)
      names.push(`${base}.island${n === 1 ? "" : n}${config.clientFileSuffix}${ext}`);
  }
  const candidates = names.map((name) => path.join(dir, name));
  const free = candidates.find((candidate) => !exists(candidate));
  return free ? { ok: true, file: free } : { ok: false, taken: candidates };
}

/** `X.client.tsx`: a generated island (or a file named like one), never a candidate itself. */
export function isIslandFile(file: string, config: ResolvedConfig): boolean {
  return path.basename(file, path.extname(file)).endsWith(config.clientFileSuffix);
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** {@link planFile}, with unexpected errors reported as `internal-error` skips. */
async function planSafely(
  run: RunContext,
  file: string,
  renames: Readonly<Record<string, string>> = {},
  traces?: Map<string, PlanTrace>,
): Promise<Outcome<Planned>> {
  try {
    return await planFile(run, file, renames, traces);
  } catch (error) {
    const err = error as Error;
    return skip("internal-error", `${err.message}\n${err.stack ?? ""}`);
  }
}

function skippedResult(run: RunContext, file: string, skipped: Skip): FileResult {
  return {
    file: rel(run.root, file),
    status: "skipped",
    skipped,
    islands: [],
    staticRatio: 0,
    diff: "",
    outputs: {},
  };
}

function changeResult(
  run: RunContext,
  file: string,
  value: Planned,
  saving: Saving,
  requires: string[] = [],
  routes: FileRoute[] = [],
): FileResult {
  const relFile = rel(run.root, file);
  const diff = Object.entries(value.outputs)
    .map(([relPath, content]) => {
      const isOriginal = relPath === relFile;
      return createTwoFilesPatch(
        isOriginal ? `a/${relPath}` : "/dev/null",
        `b/${relPath}`,
        isOriginal ? value.originalText : "",
        content,
        undefined,
        undefined,
        { context: 3 },
      );
    })
    .join("");
  const status = value.candidate.island ? "split" : "directive-removed";
  return {
    file: relFile,
    status,
    fingerprint: changeFingerprint(
      status,
      value.componentName,
      value.islands,
      value.componentSource,
    ),
    islands: value.islands,
    staticRatio: value.staticRatio,
    ...(saving.bytesSaved ? { bytesSaved: saving.bytesSaved } : {}),
    ...(saving.measureError ? { measureError: saving.measureError } : {}),
    ...(value.warnings.length > 0 ? { warnings: value.warnings } : {}),
    ...(requires.length > 0 ? { requires } : {}),
    ...(routes.length > 0 ? { routes } : {}),
    diff,
    outputs: value.outputs,
  };
}

/** Everything the synchronous part of the pipeline produces (used by the CLI/API and the ESLint rule). */
export type Analyzed = {
  file: string;
  /** The rewritten file: a Server Component, or the original without its directive. */
  serverText: string;
  /** The generated island file; undefined when only the `"use client"` directive is removed. */
  island: { file: string; specifier: string; text: string } | undefined;
  islands: IslandInfo[];
  staticRatio: number;
  importers: string[];
  serverActionProps: Set<string>;
  isJs: boolean;
  originalText: string;
  /** Name of the main component (the default export, else the first exported one). */
  componentName: string;
  /** The components' declarations, whitespace collapsed: part of the change's fingerprint. */
  componentSource: string;
  /** Risks the change carries without being refused (code that now renders on the server). */
  warnings: Warning[];
};

/** Analysis + rewrite, without formatting, self-check or measurement. Synchronous. */
export function analyzeFile(
  run: RunContext,
  file: string,
  renames: Readonly<Record<string, string>> = {},
  /** Filled in with each component's planning decisions (`--explain`). */
  traces?: Map<string, PlanTrace>,
): Outcome<Analyzed> {
  const { loaded, graph, config, framework, root } = run;
  const node = graph.nodes.get(file);
  if (!node?.inProgram) {
    return skip(
      "unsupported-pattern",
      "the file is not part of the TypeScript program (for .js/.jsx files, enable allowJs or add a jsconfig.json)",
    );
  }
  const baseName = path.basename(file).replace(/\.[^.]+$/, "");
  if (framework.mustStayClientFiles.includes(baseName)) {
    return skip(
      "unsupported-pattern",
      `Next.js requires ${path.basename(file)} to be a Client Component`,
    );
  }

  const program = loaded.project.getProgram().compilerObject;
  const sf = program.getSourceFile(file);
  if (!sf) return skip("parse-error", "the file could not be loaded");
  const ignore = findIgnoreComment(sf);
  if (ignore) {
    const lc = sf.getLineAndCharacterOfPosition(ignore.pos);
    return skip(
      "ignored",
      ignore.reason
        ? `opted out with an auto-server-split-ignore comment: ${ignore.reason}`
        : "opted out with an auto-server-split-ignore comment",
      { line: lc.line + 1, column: lc.character + 1 },
    );
  }
  const strayIgnore = findIgnoreCommentOutsideHeader(sf);
  const ignoreWarnings: Warning[] =
    strayIgnore === undefined
      ? []
      : [
          {
            code: "ignore-outside-header",
            message:
              "this auto-server-split-ignore comment isn't in the file header, so it doesn't apply; move it above the first import or onto the \"use client\" line",
            location: lineCol(sf, strayIgnore),
          },
        ];
  const syntax = program.getSyntacticDiagnostics(sf)[0];
  if (syntax) {
    const lc = sf.getLineAndCharacterOfPosition(syntax.start ?? 0);
    return skip("parse-error", ts.flattenDiagnosticMessageText(syntax.messageText, " "), {
      line: lc.line + 1,
      column: lc.character + 1,
    });
  }
  const checker = program.getTypeChecker();
  const isJs = /\.(jsx?|mjs|cjs)$/.test(file);
  const ctx: AnalysisContext = {
    program,
    checker,
    sf,
    file,
    graph,
    config,
    framework,
    isJs,
    moduleSafety: run.moduleSafety,
  };

  const ext = path.extname(file);
  const dir = config.islandsDir
    ? path.join(path.dirname(file), config.islandsDir)
    : path.dirname(file);
  // ---- whole-file checks ----------------------------------------------------------------------
  const imports = buildImportTable(sf, checker, graph);
  const facts = new FileFacts(
    sf,
    checker,
    imports,
    framework,
    run.moduleSafety.check,
    run.serverSafeHooks,
    run.rules,
  );
  for (const decl of imports.sideEffectImports) {
    const spec = (decl.moduleSpecifier as ts.StringLiteral).text;
    if (!STYLESHEET_RE.test(spec)) {
      return skip(
        "unsupported-pattern",
        `has a side-effect import of ${spec}, which would then run on the server only`,
        locOf(ctx, decl),
      );
    }
  }
  const fileSkip = specialApiSkip(ctx, facts);
  if (fileSkip) return { ok: false, skip: fileSkip };
  const env = findEnvProblem(sf, checker, framework);
  if (env) return skip("server-env-difference", env.message, locOf(ctx, env.node));

  const shape = analyzeFileShape(ctx, facts);
  if (!shape.ok) return shape;
  const components = shape.value.components;
  const importerCheck = checkImporters(program, graph, file, components);
  if (!importerCheck.ok) return importerCheck;

  // Plan every component. A non-exported helper component that is entirely interactive moves
  // wholesale into the island file; other components may then render it as a client reference,
  // so planning repeats until the set of moved components is stable.
  const wholesale = new Set<ComponentInfo>();
  let plans: ComponentPlan[] = [];
  let unchanged: ComponentInfo[] = [];
  for (let pass = 0; pass <= components.length; pass++) {
    plans = [];
    unchanged = [];
    let grew = false;
    for (const component of components) {
      if (wholesale.has(component)) continue;
      const trace = traces ? { anchors: [], steps: [] } : undefined;
      const plan = planComponent(ctx, facts, shape.value, component, {
        serverActionProps: importerCheck.value.serverActionProps,
        wholesale,
        ...(trace ? { trace } : {}),
      });
      if (trace) traces?.set(component.name, trace);
      if (plan.ok) {
        plans.push(plan.value);
        continue;
      }
      const code = plan.skip.code;
      if (code === "no-islands") {
        unchanged.push(component);
        continue;
      }
      const movable =
        (code === "fully-interactive" || code === "state-spans-component") &&
        component.exported === "none" &&
        components.length > 1;
      if (movable) {
        wholesale.add(component);
        grew = true;
        continue;
      }
      const prefix = components.length > 1 ? `${component.name}: ` : "";
      return { ok: false, skip: { ...plan.skip, message: `${prefix}${plan.skip.message}` } };
    }
    if (!grew) break;
  }
  const main =
    components.find((c) => c.exported === "default") ??
    components.find((c) => c.exported !== "none") ??
    components[0];
  const componentName = main?.name ?? path.basename(file, ext);
  const componentSource = components
    .map((c) => c.statement.getText(sf).replace(/\s+/g, " "))
    .join("\0");
  if (plans.length === 0 && wholesale.size === 0) {
    const names = `${components.map((c) => c.name).join(", ")} ${components.length === 1 ? "uses" : "use"}`;
    if (!config.removeUnusedDirectives) {
      return skip(
        "no-islands",
        `${names} no client-only features; removing "use client" may be enough (set removeUnusedDirectives to let the tool remove it)`,
      );
    }
    // Every importer is a server module that renders the components as <X />, and nothing in the
    // file is client-only, so it can run as a Server Component as it is.
    return ok({
      file,
      serverText: emitDirectiveRemoval(ctx, shape.value, imports),
      island: undefined,
      islands: [],
      staticRatio: 1,
      importers: importerCheck.value.importers,
      serverActionProps: importerCheck.value.serverActionProps,
      isJs,
      originalText: sf.text,
      componentName,
      componentSource,
      warnings: [
        ...findTimezoneWarnings(ctx, () => true),
        ...findRuleWarnings(ctx, facts, () => true),
        ...ignoreWarnings,
      ],
    });
  }
  if (components.every((c) => wholesale.has(c) || c.exported === "none") && plans.length === 0) {
    return skip(
      "fully-interactive",
      "every component in the file is interactive; nothing would stay on the server",
    );
  }

  const jsxCounts = (c: ComponentInfo) => countJsx(c.fn);
  const jsxTotal =
    plans.reduce((n, p) => n + p.jsxTotal, 0) +
    [...wholesale].reduce((n, c) => n + jsxCounts(c), 0) +
    unchanged.reduce((n, c) => n + jsxCounts(c), 0);
  const staticJsx =
    plans.reduce((n, p) => n + p.staticRatio * p.jsxTotal, 0) +
    unchanged.reduce((n, c) => n + jsxCounts(c), 0);
  const staticRatio = jsxTotal === 0 ? 0 : staticJsx / jsxTotal;
  if (staticRatio < config.minStaticRatio) {
    return skip(
      "below-threshold",
      `only ${Math.round(staticRatio * 100)}% of the JSX would stay on the server (minStaticRatio is ${Math.round(config.minStaticRatio * 100)}%)`,
    );
  }

  // Code outside the islands (and inside their server-rendered slots) now runs on the server only.
  const toIsland: ts.Node[] = [...wholesale].map((c) => c.statement);
  const serverSlots: ts.Node[] = [];
  for (const plan of plans) {
    for (const island of plan.islands) {
      if (!island.effects) toIsland.push(island.root.node);
      serverSlots.push(...island.slots.map((slot) => slot.j.node));
    }
    for (const unit of plan.removedUnits) toIsland.push(...unitNodes(unit));
    for (const decl of plan.movedModuleDecls) toIsland.push(decl.statement);
  }
  const within = (outer: ts.Node, node: ts.Node) =>
    node.getStart(sf) >= outer.getStart(sf) && node.getEnd() <= outer.getEnd();
  const stays = (node: ts.Node) =>
    serverSlots.some((slot) => within(slot, node)) ||
    !toIsland.some((moved) => within(moved, node));
  const warnings = [
    ...findTimezoneWarnings(ctx, stays),
    ...findRuleWarnings(ctx, facts, stays),
    ...ignoreWarnings,
  ];

  // ---- output location --------------------------------------------------------------------------
  const chosen = islandFileFor(file, dir, config, (f) =>
    Boolean(existsSync(f) || loaded.project.getSourceFile(f)),
  );
  if (!chosen.ok) {
    const taken = chosen.taken.map((f) => rel(root, f));
    return skip(
      "output-exists",
      taken.length > 1
        ? `${taken.join(", ")} already exist; existing files are never merged into`
        : `${taken[0] ?? ""} already exists; existing files are never merged into (set outputExists: "alternate" to use another name)`,
    );
  }
  const islandFile = chosen.file;
  if (!run.pageExtensions.ok) return skip("would-create-route", run.pageExtensions.reason);
  if (couldBecomeRoute(root, islandFile, run.pageExtensions.extensions)) {
    return skip(
      "would-create-route",
      `${rel(root, islandFile)} could be picked up as a Next.js route`,
    );
  }

  // ---- emit -------------------------------------------------------------------------------------
  const islandSpecifier = relativeSpecifier(path.dirname(file), islandFile);
  const originalSpecifier = relativeSpecifier(dir, file);
  const emitted = emitSplit({
    renames,
    ctx,
    shape: shape.value,
    imports,
    plans,
    islandSpecifier,
    originalSpecifier,
    movedComponents: [...wholesale].flatMap((c) => {
      const decl = shape.value.componentDecls.get(c);
      return decl ? [decl] : [];
    }),
    rebaseSpecifier: (spec) =>
      spec.startsWith(".") && dir !== path.dirname(file)
        ? relativeSpecifier(dir, path.resolve(path.dirname(file), spec), true)
        : spec,
  });
  if (!emitted.ok) return emitted;
  // Generated and inserted lines use the original file's line ending. A file that already mixes
  // CRLF and LF keeps its existing lines byte for byte.
  const eol = lineEndingOf(sf.text);
  const serverText = hasMixedLineEndings(sf.text)
    ? emitted.value.serverText
    : withLineEnding(emitted.value.serverText, eol);
  const islandText = withLineEnding(emitted.value.islandText, eol);

  const movedInfo: IslandInfo[] = [...wholesale].map((c) => ({
    name: c.name,
    rootTag: rootTagOf(c, sf),
    props: [],
    line: sf.getLineAndCharacterOfPosition(c.statement.getStart(sf)).line + 1,
    moved: true,
  }));
  const islands: IslandInfo[] = [
    ...emitted.value.islands.map((i) => ({
      name: i.name,
      rootTag: i.rootTag,
      props: [...i.props.map((p) => p.name), ...i.slots.map((slot) => slot.name)],
      line: i.line,
      ...(i.effects ? { effects: true } : {}),
    })),
    ...movedInfo,
  ].sort((a, b) => a.line - b.line);

  return ok({
    file,
    serverText,
    island: { file: islandFile, specifier: islandSpecifier, text: islandText },
    islands,
    staticRatio,
    importers: importerCheck.value.importers,
    serverActionProps: importerCheck.value.serverActionProps,
    isJs,
    originalText: sf.text,
    componentName,
    componentSource,
    warnings,
  });
}

/** Runs the self-check on an analysed file's output. Synchronous. */
export function checkAnalyzed(
  run: RunContext,
  analyzed: Analyzed,
  serverText = analyzed.serverText,
  islandText = analyzed.island?.text,
): Outcome<void> {
  const { island } = analyzed;
  return selfCheck({
    loaded: run.loaded,
    graph: run.graph,
    framework: run.framework,
    classifier: run.classifier,
    moduleSafety: run.moduleSafety,
    serverSafeHooks: run.serverSafeHooks,
    rules: run.rules,
    file: analyzed.file,
    serverText,
    island: island && { ...island, text: islandText ?? island.text },
    importers: analyzed.importers,
    serverActionProps: analyzed.serverActionProps,
    isJs: analyzed.isJs,
  });
}

async function planFile(
  run: RunContext,
  file: string,
  renames: Readonly<Record<string, string>>,
  traces?: Map<string, PlanTrace>,
): Promise<Outcome<Planned>> {
  const { config, root } = run;
  const analyzed = analyzeFile(run, file, renames, traces);
  if (!analyzed.ok) return analyzed;
  const a = analyzed.value;
  let serverText = a.serverText;
  let island = a.island && { file: a.island.file, text: a.island.text };
  const format =
    config.prettier === "auto" ? await projectFormatter(root, file, a.originalText) : undefined;
  if (format) {
    serverText = await format(file, serverText);
    if (island) island = { file: island.file, text: await format(island.file, island.text) };
  }

  const checked = checkAnalyzed(run, a, serverText, island?.text);
  if (!checked.ok) return checked;

  return ok({
    outputs: {
      [rel(root, file)]: serverText,
      ...(island ? { [rel(root, island.file)]: island.text } : {}),
    },
    islands: a.islands,
    staticRatio: a.staticRatio,
    originalText: a.originalText,
    candidate: { file, originalText: a.originalText, serverText, ...(island ? { island } : {}) },
    warnings: a.warnings,
    componentName: a.componentName,
    componentSource: a.componentSource,
  });
}

/** The splits a run's size estimates assume, and the saving of any split measured against them. */
export type SavingsEstimate = {
  /**
   * The saving of `candidate` (a kept one, a dropped one, or a new version of one) when it is split
   * along with the candidates that pass `minBytesSaved` together, with the threshold applied.
   */
  outcome(candidate: SplitCandidate): Outcome<Saving>;
  /** The candidates the estimates assume are applied: those that pass `minBytesSaved` together. */
  kept: ReadonlySet<string>;
  /** The kept candidates themselves (this run's and the other proposed changes). */
  candidates: readonly SplitCandidate[];
};

/**
 * The changes the other "use client" files in the config's `include` (not `decided`) would get,
 * analysed as they are on disk. `prepare` runs before each file is analysed (the ESLint rule loads
 * it into its lazy project). Synchronous.
 */
export function extraCandidates(
  run: RunContext,
  decided: ReadonlySet<string>,
  prepare?: (file: string) => void,
): SplitCandidate[] {
  const out: SplitCandidate[] = [];
  for (const file of selectTargets(run.root, undefined, run.config, run.baseline)) {
    if (decided.has(file)) continue;
    if (run.graph.nodes.get(file)?.directive !== "use client") continue;
    try {
      prepare?.(file);
      const analyzed = analyzeFile(run, file);
      if (analyzed.ok) {
        const { originalText, island, serverText } = analyzed.value;
        out.push({ file, originalText, serverText, ...(island ? { island } : {}) });
      }
    } catch {
      // Reported when that file itself is split or linted; here it just isn't a split.
    }
  }
  return out;
}

/**
 * Size estimates assume every split the tool would propose for the project is applied: `planned`
 * (the run's own splits, from every pass) plus the splits of the other "use client" files in the
 * config's `include` (`extras`, else {@link extraCandidates}), so a file's estimate doesn't depend
 * on which paths a run covers. `decided` files (the run's targets) are never re-analysed. A split
 * below `minBytesSaved` (or one that can't be measured, unless the threshold is 0) is dropped,
 * which can lower the others' savings: code they shared with it keeps shipping. A candidate whose
 * `requires` (the changes a later pass found it after) aren't all kept is dropped too. So dropping
 * repeats until the set is stable. Removing an unused directive creates no file, so
 * `minBytesSaved` doesn't apply to it. Measured against `run`'s module graph, which is the project
 * on disk: the candidates of later passes change only their own file and add an island. Synchronous.
 */
export function estimateSavings(
  run: RunContext,
  planned: SplitCandidate[],
  decided: ReadonlySet<string> = new Set(),
  options: {
    prepare?: (file: string) => void;
    extras?: SplitCandidate[];
    requires?: ReadonlyMap<string, readonly string[]>;
  } = {},
): SavingsEstimate {
  const { measurer, config } = run;
  if (!measurer)
    return {
      outcome: () => ok({}),
      kept: new Set(planned.map((c) => c.file)),
      candidates: planned,
    };
  const requires = options.requires ?? new Map<string, readonly string[]>();
  const candidates = new Map(
    (options.extras ?? extraCandidates(run, decided, options.prepare)).map((c) => [c.file, c]),
  );
  for (const c of planned) candidates.set(c.file, c);

  const passes = (c: SplitCandidate, m: Measurement | undefined): boolean =>
    m !== undefined &&
    (!c.island ||
      ("error" in m
        ? config.minBytesSaved === 0
        : m.bytesSaved.conservative >= config.minBytesSaved));
  let kept = [...candidates.values()];
  let measured = measurer.measure(kept);
  for (;;) {
    const files = new Set(kept.map((c) => c.file));
    const next = kept.filter(
      (c) =>
        passes(c, measured.get(c.file)) && (requires.get(c.file) ?? []).every((r) => files.has(r)),
    );
    if (next.length === kept.length) break;
    kept = next;
    measured = measurer.measure(kept);
  }
  const final = kept;
  const finalMeasured = measured;
  return {
    kept: new Set(final.map((c) => c.file)),
    candidates: final,
    outcome: (candidate) => {
      const same = final.find((c) => c.file === candidate.file);
      const m =
        same?.originalText === candidate.originalText &&
        same.island?.text === candidate.island?.text
          ? finalMeasured.get(candidate.file)
          : measurer
              .measure([...final.filter((c) => c.file !== candidate.file), candidate])
              .get(candidate.file);
      return savingOutcome(run, m, candidate.island === undefined);
    },
  };
}

/** Applies `minBytesSaved` to a measurement (unless `exempt`: a removed directive). */
function savingOutcome(
  run: RunContext,
  m: Measurement | undefined,
  exempt: boolean,
): Outcome<Saving> {
  const { config, root } = run;
  if (!m) return ok({});
  const threshold = formatBytes(config.minBytesSaved);
  if ("error" in m) {
    if (config.minBytesSaved === 0 || exempt) return ok({ measureError: m.error });
    return skip(
      "measure-failed",
      `the saving couldn't be measured (${m.error}), so minBytesSaved (${threshold}) can't be checked; set minBytesSaved to 0 or pass --no-measure to split without an estimate`,
    );
  }
  const { isolated, conservative } = m.bytesSaved;
  if (conservative < config.minBytesSaved && !exempt) {
    return skip(
      "below-threshold",
      `saves an estimated ${formatBytes(conservative)} gzip (minBytesSaved is ${threshold})`,
    );
  }
  const sharedWith = m.sharedWith.map((f) => rel(root, f));
  return ok({
    bytesSaved: { isolated, conservative, ...(sharedWith.length > 0 ? { sharedWith } : {}) },
  });
}

function specialApiSkip(ctx: AnalysisContext, facts: FileFacts): Skip | undefined {
  // memo()/forwardRef() around a component: analyzeFileShape decides whether it can be unwrapped.
  const wrappers = wrapperCalleeHeads(ctx.sf, facts);
  for (const marker of facts.scanMarkers(ctx.sf)) {
    if (marker.special === "hoc" && wrappers.has(marker.node)) continue;
    const loc = locOf(ctx, marker.node);
    switch (marker.special) {
      case "css-in-js":
        return {
          code: "css-in-js-runtime",
          message: `uses ${marker.detail}; runtime CSS-in-JS is always skipped`,
          location: loc,
        };
      case "context":
        return {
          code: "context-provider",
          message: "creates a React Context (createContext)",
          location: loc,
        };
      case "class":
        return {
          code: "class-component",
          message: "uses React.Component / PureComponent",
          location: loc,
        };
      case "hoc":
        return {
          code: "hoc",
          message: `uses ${marker.detail}, which this version doesn't split`,
          location: loc,
        };
      case "lazy":
      case "dynamic":
        return {
          code: "dynamic-import",
          message: `uses ${marker.detail}, which this version doesn't split`,
          location: loc,
        };
      default:
        break;
    }
  }
  let dynamicImport: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (dynamicImport) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)
      dynamicImport = n;
    ts.forEachChild(n, visit);
  };
  visit(ctx.sf);
  if (dynamicImport)
    return {
      code: "dynamic-import",
      message: "uses import(), which this version doesn't split",
      location: locOf(ctx, dynamicImport),
    };
  return undefined;
}

/** The tag of the element a component returns (used to describe components moved wholesale). */
function rootTagOf(component: ComponentInfo, sf: ts.SourceFile): string {
  let tag = component.name;
  const visit = (n: ts.Node): boolean => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      tag = tagNameText(sf, n);
      return true;
    }
    return ts.forEachChild(n, visit) ?? false;
  };
  if (component.fn.body) visit(component.fn.body);
  return tag;
}

function countJsx(node: ts.Node): number {
  let n = 0;
  const visit = (child: ts.Node): void => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) n++;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return n;
}

function relativeSpecifier(fromDir: string, toFile: string, keepExtension = false): string {
  let target = path.relative(fromDir, toFile).split(path.sep).join("/");
  if (!keepExtension) target = target.replace(/\.(tsx|ts|jsx|js|mts|mjs)$/, "");
  return target.startsWith(".") ? target : `./${target}`;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
