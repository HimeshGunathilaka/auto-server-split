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
import { findConfigFile, loadConfigFile, resolveConfig } from "./config/config.js";
import { couldBecomeRoute, nextAdapter, readPageExtensions } from "./frameworks/next.js";
import type { BundleMeasurer } from "./measure/bundleSize.js";
import type { LoadedProject } from "./project/loadProject.js";
import { IGNORE_GLOBS, loadProject } from "./project/loadProject.js";
import type { ModuleGraph } from "./project/moduleGraph.js";
import { buildModuleGraph } from "./project/moduleGraph.js";
import { PackageClassifier } from "./project/packages.js";
import { emitSplit } from "./transform/emit.js";
import { formatWithProjectPrettier } from "./transform/format.js";
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
};

type Planned = {
  outputs: Record<string, string>;
  islands: IslandInfo[];
  staticRatio: number;
  bytesSaved?: { isolated: number; conservative: number };
  originalText: string;
};

/** Builds the shared state for one run: project, module graph, classifiers. Synchronous. */
export function createRunContext(
  root: string,
  config: ResolvedConfig,
  options: { lazy?: boolean; tsconfig?: string } = {},
): RunContext {
  const framework = nextAdapter;
  const loaded = loadProject(root, {
    lazy: options.lazy ?? false,
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
  });
  const classifier = new PackageClassifier(framework, config.clientOnlyPackages);
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

export async function runSplit(options: SplitOptions = {}): Promise<
  SplitResult & {
    filesScanned: number;
    /** Re-runs one file with island renames (interactive mode). */
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
  const config = resolveConfig(fileConfig, options.config);

  const run = createRunContext(root, config);
  if (options.measure !== false) {
    const { BundleMeasurer } = await import("./measure/bundleSize.js");
    run.measurer = new BundleMeasurer(root, run.graph, run.loaded.configFile);
  }
  const { graph, measurer } = run;

  const targets = selectTargets(root, options.paths, config);
  const files: FileResult[] = [];
  for (const file of targets) {
    const node = graph.nodes.get(file);
    if (node?.directive !== "use client") continue;
    const result = await processFile(run, file);
    files.push(result);
    options.onFile?.(result);
  }

  if (options.write) {
    for (const result of files) {
      if (result.status !== "split") continue;
      for (const [rel, content] of Object.entries(result.outputs)) {
        const abs = path.join(root, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
  }
  await measurer?.dispose();
  return {
    files,
    filesScanned: targets.length,
    rerun: (relFile, renames) => processFile(run, path.resolve(root, relFile), renames),
  };
}

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
    .filter((f) => /\.(tsx|jsx|ts|js|mts|mjs)$/.test(f))
    .sort();
}

function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

async function processFile(
  run: RunContext,
  file: string,
  renames: Readonly<Record<string, string>> = {},
): Promise<FileResult> {
  const relFile = rel(run.root, file);
  const base: FileResult = {
    file: relFile,
    status: "skipped",
    islands: [],
    staticRatio: 0,
    diff: "",
    outputs: {},
  };
  try {
    const planned = await planFile(run, file, renames);
    if (!planned.ok) return { ...base, skipped: planned.skip };
    const value = planned.value;
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
      status: "split",
      islands: value.islands,
      staticRatio: value.staticRatio,
      ...(value.bytesSaved ? { bytesSaved: value.bytesSaved } : {}),
      diff,
      outputs: value.outputs,
    };
  } catch (error) {
    const err = error as Error;
    return {
      ...base,
      skipped: { code: "internal-error", message: `${err.message}\n${err.stack ?? ""}` },
    };
  }
}

/** Everything the synchronous part of the pipeline produces (used by the CLI/API and the ESLint rule). */
export type Analyzed = {
  file: string;
  islandFile: string;
  islandSpecifier: string;
  serverText: string;
  islandText: string;
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

  // ---- output location ------------------------------------------------------------------------
  const ext = path.extname(file);
  const dir = config.islandsDir
    ? path.join(path.dirname(file), config.islandsDir)
    : path.dirname(file);
  const islandFile = path.join(dir, `${path.basename(file, ext)}${config.clientFileSuffix}${ext}`);
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
  if (plans.length === 0 && wholesale.size === 0) {
    return skip(
      "no-islands",
      `${components.map((c) => c.name).join(", ")} ${components.length === 1 ? "uses" : "use"} no client-only features; removing "use client" may be enough (the tool never removes it automatically)`,
    );
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
  const main =
    components.find((c) => c.exported === "default") ??
    components.find((c) => c.exported !== "none") ??
    components[0];

  return ok({
    file,
    islandFile,
    islandSpecifier,
    serverText: emitted.value.serverText,
    islandText: emitted.value.islandText,
    islands,
    staticRatio,
    importers: importerCheck.value.importers,
    serverActionProps: importerCheck.value.serverActionProps,
    isJs,
    originalText: sf.text,
    componentName: main?.name ?? path.basename(file, ext),
  });
}

/** Runs the self-check on an analysed file's output. Synchronous. */
export function checkAnalyzed(
  run: RunContext,
  analyzed: Analyzed,
  serverText = analyzed.serverText,
  islandText = analyzed.islandText,
): Outcome<void> {
  return selfCheck({
    loaded: run.loaded,
    graph: run.graph,
    framework: run.framework,
    classifier: run.classifier,
    moduleSafety: run.moduleSafety,
    serverSafeHooks: run.serverSafeHooks,
    file: analyzed.file,
    islandFile: analyzed.islandFile,
    islandSpecifier: analyzed.islandSpecifier,
    serverText,
    islandText,
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
  let islandText = a.islandText;
  if (config.prettier === "auto") {
    serverText = await formatWithProjectPrettier(root, file, serverText);
    islandText = await formatWithProjectPrettier(root, a.islandFile, islandText);
  }

  const checked = checkAnalyzed(run, a, serverText, islandText);
  if (!checked.ok) return checked;

  let bytesSaved: Planned["bytesSaved"];
  if (run.measurer) {
    bytesSaved = await run.measurer.measure(file, a.originalText, a.islandFile, islandText);
    if (bytesSaved && bytesSaved.conservative < config.minBytesSaved) {
      return skip(
        "below-threshold",
        `saves an estimated ${formatBytes(bytesSaved.conservative)} gzip (minBytesSaved is ${formatBytes(config.minBytesSaved)})`,
      );
    }
  }

  return ok({
    outputs: { [rel(root, file)]: serverText, [rel(root, a.islandFile)]: islandText },
    islands: a.islands,
    staticRatio: a.staticRatio,
    ...(bytesSaved ? { bytesSaved } : {}),
    originalText: a.originalText,
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
