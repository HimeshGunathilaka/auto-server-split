import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import type { ComponentPlan } from "./analysis/islands.js";
import { planComponent } from "./analysis/islands.js";
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

type RunContext = {
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

export async function runSplit(
  options: SplitOptions = {},
): Promise<SplitResult & { filesScanned: number }> {
  const root = path.resolve(options.root ?? process.cwd());
  const configFile = options.noConfigFile
    ? undefined
    : options.configFile
      ? path.resolve(root, options.configFile)
      : findConfigFile(root);
  const fileConfig = configFile ? await loadConfigFile(configFile) : undefined;
  const config = resolveConfig(fileConfig, options.config);
  const framework = nextAdapter;

  const loaded = loadProject(root);
  const classifier = new PackageClassifier(framework, config.clientOnlyPackages);
  const graph = buildModuleGraph(loaded, classifier);
  const serverSafeHooks = new Set(config.serverSafeHooks);
  const moduleSafety = new ModuleSafety(
    () => loaded.project.getProgram().compilerObject,
    graph,
    framework,
    serverSafeHooks,
  );
  let measurer: BundleMeasurer | undefined;
  if (options.measure !== false) {
    const { BundleMeasurer } = await import("./measure/bundleSize.js");
    measurer = new BundleMeasurer(root, graph, loaded.configFile);
  }
  const run: RunContext = {
    root,
    config,
    framework,
    loaded,
    graph,
    classifier,
    moduleSafety,
    serverSafeHooks,
    pageExtensions: readPageExtensions(root),
    measurer,
  };

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
  return { files, filesScanned: targets.length };
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

async function processFile(run: RunContext, file: string): Promise<FileResult> {
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
    const planned = await planFile(run, file);
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

async function planFile(run: RunContext, file: string): Promise<Outcome<Planned>> {
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
      `${rel(root, islandFile)} already exists; v1 never merges into existing files`,
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
  if (shape.value.components.length > 1) {
    return skip(
      "unsupported-pattern",
      `declares ${shape.value.components.length} components (${shape.value.components.map((c) => c.name).join(", ")}); multiple components per file are supported from v0.4`,
    );
  }

  const importerCheck = checkImporters(program, graph, file, shape.value.components);
  if (!importerCheck.ok) return importerCheck;

  const plans: ComponentPlan[] = [];
  for (const component of shape.value.components) {
    const plan = planComponent(ctx, facts, shape.value, component, {
      serverActionProps: importerCheck.value.serverActionProps,
    });
    if (!plan.ok) return plan;
    plans.push(plan.value);
  }
  const jsxTotal = plans.reduce((n, p) => n + p.jsxTotal, 0);
  const staticRatio =
    jsxTotal === 0 ? 0 : plans.reduce((n, p) => n + p.staticRatio * p.jsxTotal, 0) / jsxTotal;
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
    ctx,
    shape: shape.value,
    imports,
    plans,
    islandSpecifier,
    originalSpecifier,
    rebaseSpecifier: (spec) =>
      spec.startsWith(".") && dir !== path.dirname(file)
        ? relativeSpecifier(dir, path.resolve(path.dirname(file), spec), true)
        : spec,
  });
  if (!emitted.ok) return emitted;

  let serverText = emitted.value.serverText;
  let islandText = emitted.value.islandText;
  if (config.prettier === "auto") {
    serverText = await formatWithProjectPrettier(root, file, serverText);
    islandText = await formatWithProjectPrettier(root, islandFile, islandText);
  }

  // ---- self-check -------------------------------------------------------------------------------
  const checked = selfCheck({
    loaded,
    graph,
    framework,
    classifier: run.classifier,
    moduleSafety: run.moduleSafety,
    serverSafeHooks: run.serverSafeHooks,
    file,
    islandFile,
    islandSpecifier,
    serverText,
    islandText,
    importers: importerCheck.value.importers,
    serverActionProps: importerCheck.value.serverActionProps,
    isJs,
  });
  if (!checked.ok) return checked;

  const islands: IslandInfo[] = emitted.value.islands.map((i) => ({
    name: i.name,
    rootTag: i.rootTag,
    props: [...i.props.map((p) => p.name), ...i.slots.map((slot) => slot.name)],
    line: i.line,
  }));

  // ---- measure ------------------------------------------------------------------------------------
  let bytesSaved: Planned["bytesSaved"];
  if (run.measurer) {
    bytesSaved = await run.measurer.measure(file, sf.text, islandFile, islandText);
    if (bytesSaved && bytesSaved.conservative < config.minBytesSaved) {
      return skip(
        "below-threshold",
        `saves an estimated ${formatBytes(bytesSaved.conservative)} gzip (minBytesSaved is ${formatBytes(config.minBytesSaved)})`,
      );
    }
  }

  return ok({
    outputs: { [rel(root, file)]: serverText, [rel(root, islandFile)]: islandText },
    islands,
    staticRatio,
    ...(bytesSaved ? { bytesSaved } : {}),
    originalText: sf.text,
  });
}

function specialApiSkip(ctx: AnalysisContext, facts: FileFacts): Skip | undefined {
  for (const marker of facts.scanMarkers(ctx.sf)) {
    const loc = locOf(ctx, marker.node);
    switch (marker.special) {
      case "css-in-js":
        return {
          code: "css-in-js-runtime",
          message: `uses ${marker.detail}; v1 always skips runtime CSS-in-JS`,
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
          message: `uses ${marker.detail}, which v1 doesn't split`,
          location: loc,
        };
      case "lazy":
      case "dynamic":
        return {
          code: "dynamic-import",
          message: `uses ${marker.detail}, which v1 doesn't split`,
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
      message: "uses import(), which v1 doesn't split",
      location: locOf(ctx, dynamicImport),
    };
  return undefined;
}

export function relativeSpecifier(fromDir: string, toFile: string, keepExtension = false): string {
  let target = path.relative(fromDir, toFile).split(path.sep).join("/");
  if (!keepExtension) target = target.replace(/\.(tsx|ts|jsx|js|mts|mjs)$/, "");
  return target.startsWith(".") ? target : `./${target}`;
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}
