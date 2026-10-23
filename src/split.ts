import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import fg from "fast-glob";
import { ts } from "ts-morph";
import { analyzeFileShape } from "./analysis/components.js";
import type { AnalysisContext } from "./analysis/context.js";
import { locOf } from "./analysis/context.js";
import type { FrameworkAdapter } from "./analysis/framework.js";
import { buildImportTable } from "./analysis/importTable.js";
import { checkImporters } from "./analysis/importers.js";
import type { ComponentInfo } from "./analysis/components.js";
import type { ComponentPlan } from "./analysis/islands.js";
import { planComponent } from "./analysis/islands.js";
import { tagNameText } from "./analysis/refs.js";
import { ModuleSafety } from "./analysis/moduleSafety.js";
import type { Outcome, Skip } from "./analysis/skip.js";
import { ok, skip } from "./analysis/skip.js";
import { FileFacts, findEnvProblem } from "./analysis/taint.js";
import { findConfigFile, loadConfigFile, resolveConfig, validateConfig } from "./config/config.js";
import { couldBecomeRoute, nextAdapter, readPageExtensions } from "./frameworks/next.js";
import type { BundleMeasurer, Measurement, SplitCandidate } from "./measure/bundleSize.js";
import type { LoadedProject } from "./project/loadProject.js";
import { IGNORE_GLOBS, loadProject, setSourceText } from "./project/loadProject.js";
import type { ModuleGraph } from "./project/moduleGraph.js";
import { buildModuleGraph } from "./project/moduleGraph.js";
import { PackageClassifier } from "./project/packages.js";
import { emitSplit, withoutDirective } from "./transform/emit.js";
import { projectFormatter } from "./transform/format.js";
import { hasMixedLineEndings, lineEndingOf, withLineEnding } from "./transform/text.js";
import type { FileResult, IslandInfo, ResolvedConfig, SplitOptions, SplitResult } from "./types.js";
import { selfCheck } from "./verify/selfCheck.js";

const STYLESHEET_RE = /\.(css|scss|sass|less|styl|pcss)$/;

export type RunContext = {
  root: string;
  config: ResolvedConfig;
  framework: FrameworkAdapter;
  loaded: LoadedProject;
  graph: ModuleGraph;
  classifier: PackageClassifier;
  moduleSafety: ModuleSafety;
  serverSafeHooks: ReadonlySet<string>;
  pageExtensions: ReturnType<typeof readPageExtensions>;
  measurer: BundleMeasurer | undefined;
  /** The splits the run's size estimates assume (see estimateSavings), once computed. */
  estimate?: SavingsEstimate;
};

type Saving = Pick<FileResult, "bytesSaved" | "measureError">;

/** A split that passed analysis, formatting and the self-check; its saving comes later. */
type Planned = {
  outputs: Record<string, string>;
  islands: IslandInfo[];
  staticRatio: number;
  originalText: string;
  candidate: SplitCandidate;
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
  const classifier = new PackageClassifier(
    framework,
    config.clientOnlyPackages,
    config.serverSafePackages,
  );
  const graph = buildModuleGraph(loaded, classifier);
  const serverSafeHooks = new Set(config.serverSafeHooks);
  const moduleSafety = new ModuleSafety(
    () => loaded.project.getProgram().compilerObject,
    graph,
    framework,
    serverSafeHooks,
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

export async function runSplit(options: SplitOptions = {}): Promise<
  SplitResult & {
    filesScanned: number;
    /**
     * Re-runs one file with island renames (interactive mode). Only for single-pass runs
     * (`iterate: false`): later passes change the project the first pass analysed.
     */
    rerun: (relFile: string, renames: Readonly<Record<string, string>>) => Promise<FileResult>;
  }
> {
  // Real path: TypeScript resolves symlinks (e.g. macOS /var -> /private/var), so globbed paths must too.
  const root = realpathSync(path.resolve(options.root ?? process.cwd()));
  const configFile = options.noConfigFile
    ? undefined
    : options.configFile
      ? path.resolve(root, options.configFile)
      : findConfigFile(root);
  const fileConfig = configFile ? await loadConfigFile(configFile) : undefined;
  const overrides = options.config
    ? validateConfig(options.config, "split({ config })")
    : undefined;
  const config = resolveConfig(fileConfig, overrides);
  const iterate = options.iterate !== false;

  const run = createRunContext(root, config);
  const Measurer =
    options.measure === false
      ? undefined
      : (await import("./measure/bundleSize.js")).BundleMeasurer;
  if (Measurer) run.measurer = new Measurer(root, run.graph, run.loaded.configFile);

  const targets = selectTargets(root, options.paths, config);
  const results = new Map<string, FileResult>();
  const report = (file: string, result: FileResult) => {
    results.set(file, result);
    options.onFile?.(result);
  };

  /**
   * Plans `files` against `ctx`. A file's estimated saving depends on the other splits, so every
   * file is analysed first.
   */
  const runPass = async (
    ctx: RunContext,
    files: string[],
    done: (file: string, result: FileResult) => void,
  ) => {
    const planned = new Map<string, Planned>();
    for (const file of files) {
      const outcome = await planSafely(ctx, file);
      if (!outcome.ok) done(file, skippedResult(ctx, file, outcome.skip));
      else if (ctx.measurer) planned.set(file, outcome.value);
      else done(file, changeResult(ctx, file, outcome.value, {}));
    }
    if (!ctx.measurer || planned.size === 0) return;
    ctx.estimate = estimateSavings(
      ctx,
      [...planned.values()].map((p) => p.candidate),
      new Set(targets),
    );
    for (const [file, value] of planned) {
      const saving = ctx.estimate.outcome(value.candidate);
      done(
        file,
        saving.ok
          ? changeResult(ctx, file, value, saving.value)
          : skippedResult(ctx, file, saving.skip),
      );
    }
  };

  // A file imported by a client module may become changeable once that importer is split (or loses
  // its directive), so with `iterate` its skip is held back and the file is analysed again in a
  // pass that sees the earlier changes. Every other result is final when it's made.
  const held = new Map<string, FileResult>();
  let ctx = run;
  let files = targets.filter((file) => run.graph.nodes.get(file)?.directive === "use client");
  let passes = 0;
  while (files.length > 0) {
    passes++;
    const changes: FileResult[] = [];
    await runPass(ctx, files, (file, result) => {
      if (isChange(result)) changes.push(result);
      if (iterate && result.skipped?.code === "imported-by-client") {
        held.set(file, result);
      } else {
        held.delete(file);
        report(file, result);
      }
    });
    if (!iterate || changes.length === 0 || held.size === 0 || passes >= MAX_PASSES) break;
    const outputs = new Map(
      changes.flatMap((c) =>
        Object.entries(c.outputs).map(
          ([relPath, text]) => [path.join(root, relPath), text] as const,
        ),
      ),
    );
    ctx = nextPassContext(ctx, outputs);
    if (Measurer) ctx.measurer = new Measurer(root, ctx.graph, ctx.loaded.configFile);
    files = [...held.keys()];
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
    filesScanned: targets.length,
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
 * earlier contexts share the project, so they no longer describe the files on disk. Size estimates
 * still bundle the files a candidate imports as they are on disk.
 */
function nextPassContext(run: RunContext, outputs: ReadonlyMap<string, string>): RunContext {
  const { loaded } = run;
  for (const [file, text] of outputs) {
    const sf = loaded.project.getSourceFile(file);
    if (sf) setSourceText(sf, text);
    else loaded.project.createSourceFile(file, text);
  }
  loaded.overlay = new Map([...(loaded.overlay ?? []), ...outputs]);
  return contextFor(run.root, run.config, loaded);
}

/** The "use client" files a run targets: `paths`, or the config's `include` globs. */
function selectTargets(
  root: string,
  paths: string[] | undefined,
  config: ResolvedConfig,
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
    .filter((f) => /\.(tsx|jsx|ts|js|mts|mjs)$/.test(f) && !isIslandFile(f, config))
    .sort();
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
): Promise<Outcome<Planned>> {
  try {
    return await planFile(run, file, renames);
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

function changeResult(run: RunContext, file: string, value: Planned, saving: Saving): FileResult {
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
  return {
    file: relFile,
    status: value.candidate.island ? "split" : "directive-removed",
    islands: value.islands,
    staticRatio: value.staticRatio,
    ...(saving.bytesSaved ? { bytesSaved: saving.bytesSaved } : {}),
    ...(saving.measureError ? { measureError: saving.measureError } : {}),
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
};

/** Analysis + rewrite, without formatting, self-check or measurement. Synchronous. */
export function analyzeFile(
  run: RunContext,
  file: string,
  renames: Readonly<Record<string, string>> = {},
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
  const islandFile = path.join(dir, `${path.basename(file, ext)}${config.clientFileSuffix}${ext}`);
  // ---- whole-file checks ----------------------------------------------------------------------
  const imports = buildImportTable(sf, checker, graph);
  const facts = new FileFacts(
    sf,
    checker,
    imports,
    framework,
    run.moduleSafety.check,
    run.serverSafeHooks,
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
      const plan = planComponent(ctx, facts, shape.value, component, {
        serverActionProps: importerCheck.value.serverActionProps,
        wholesale,
      });
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
      serverText: withoutDirective(sf),
      island: undefined,
      islands: [],
      staticRatio: 1,
      importers: importerCheck.value.importers,
      serverActionProps: importerCheck.value.serverActionProps,
      isJs,
      originalText: sf.text,
      componentName,
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

  // ---- output location --------------------------------------------------------------------------
  if (existsSync(islandFile) || loaded.project.getSourceFile(islandFile)) {
    return skip(
      "output-exists",
      `${rel(root, islandFile)} already exists; existing files are never merged into`,
    );
  }
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
): Promise<Outcome<Planned>> {
  const { config, root } = run;
  const analyzed = analyzeFile(run, file, renames);
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
    candidate: { file, originalText: a.originalText, ...(island ? { island } : {}) },
  });
}

/** The splits a run's size estimates assume, and the saving of any split measured against them. */
export type SavingsEstimate = {
  /**
   * The saving of `candidate` (a kept one, a dropped one, or a new version of one) when it is split
   * along with the candidates that pass `minBytesSaved` together, with the threshold applied.
   */
  outcome(candidate: SplitCandidate): Outcome<Saving>;
};

/**
 * Size estimates assume every split the tool would propose for the project is applied: `planned`
 * (the run's own splits) plus the splits of the other "use client" files in the config's
 * `include`, so a file's estimate doesn't depend on which paths a run covers. `decided` files (the
 * run's targets) are never re-analysed. A split below `minBytesSaved` (or one that can't be
 * measured, unless the threshold is 0) is dropped, which can lower the others' savings: code they
 * shared with it keeps shipping. So dropping repeats until the set is stable. Removing an unused
 * directive creates no file, so `minBytesSaved` doesn't apply to it. `prepare` runs
 * before each extra file is analysed (the ESLint rule loads it into its lazy project). Synchronous.
 */
export function estimateSavings(
  run: RunContext,
  planned: SplitCandidate[],
  decided: ReadonlySet<string> = new Set(),
  prepare?: (file: string) => void,
): SavingsEstimate {
  const { measurer, config } = run;
  if (!measurer) return { outcome: () => ok({}) };
  const candidates = new Map(planned.map((c) => [c.file, c]));
  for (const file of selectTargets(run.root, undefined, config)) {
    if (candidates.has(file) || decided.has(file)) continue;
    if (run.graph.nodes.get(file)?.directive !== "use client") continue;
    try {
      prepare?.(file);
      const analyzed = analyzeFile(run, file);
      if (analyzed.ok) {
        const { originalText, island } = analyzed.value;
        candidates.set(file, { file, originalText, ...(island ? { island } : {}) });
      }
    } catch {
      // Reported when that file itself is split or linted; here it just isn't a split.
    }
  }

  const passes = (c: SplitCandidate, m: Measurement | undefined): boolean =>
    m !== undefined &&
    (!c.island ||
      ("error" in m
        ? config.minBytesSaved === 0
        : m.bytesSaved.conservative >= config.minBytesSaved));
  let kept = [...candidates.values()];
  let measured = measurer.measure(kept);
  for (;;) {
    const next = kept.filter((c) => passes(c, measured.get(c.file)));
    if (next.length === kept.length) break;
    kept = next;
    measured = measurer.measure(kept);
  }
  const final = kept;
  const finalMeasured = measured;
  return {
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
  for (const marker of facts.scanMarkers(ctx.sf)) {
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
