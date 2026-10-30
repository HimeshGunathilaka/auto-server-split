import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";
import type { PlanTrace } from "./analysis/islands.js";
import { ConfigError } from "./config/config.js";
import type { SkipCode } from "./analysis/skip.js";
import type { ModuleGraph } from "./project/moduleGraph.js";
import type { ModuleEdge } from "./project/moduleTypes.js";
import type { RunContext } from "./split.js";
import { isChange, isIslandFile, runSplit } from "./split.js";
import type { FileResult, SplitOptions } from "./types.js";

/** Why a file is client or server code, and what the tool would do with it (`--explain`). */
export type Explanation = {
  /** Relative to the project root. */
  file: string;
  /**
   * `"client-boundary"`: a `"use client"` file; `"client"`: client code because a `"use client"`
   * module imports it (`clientChain` says how); `"server"`: only Server Components import it;
   * `"outside-project"`: the module graph doesn't cover it.
   */
  kind: "client-boundary" | "client" | "server" | "outside-project";
  directive?: "use client" | "use server";
  /** True when no module imports the file (a route file, a config, or unused). */
  unimported?: boolean;
  /** The shortest import chain that makes the file client code, from the `"use client"` module. */
  clientChain?: string[];
  /** The Server Components that render the boundary (the file, or the one `clientChain` starts at). */
  renderedBy?: { file: string; line: number }[];
  /**
   * For a module without a directive: whether a Server Component could import it, as a whole and
   * export by export (an export only needs what it uses to be server-safe).
   */
  serverUse?: {
    safe: boolean;
    reason?: string;
    /** `clientReference`: a Client Component re-exported here, which a Server Component can render. */
    exports: { name: string; safe: boolean; reason?: string; clientReference?: boolean }[];
  };
  /** For a `"use client"` file: the run's result for it. */
  result?: FileResult;
  /** Per component: the elements that use client-only code, and how the islands were formed. */
  components?: { name: string; anchors: PlanTrace["anchors"]; steps: string[] }[];
  /**
   * For a change: what happens to each module the file imported (a package name or a project
   * path): it moves into the island, stays on the server and leaves the client bundle, or stays on
   * the server but still ships because other client code imports it.
   */
  imports?: {
    module: string;
    fate: "island" | "leaves-client" | "still-shipped" | "server-only";
  }[];
  /** What to do about a skip. */
  suggestion?: string;
  /** Why the file isn't analysed as a candidate (a generated island). */
  note?: string;
};

/** One line on what to do about each skip (docs/skip-reasons.md has the long form). */
const FIXES: Partial<Record<SkipCode, string>> = {
  "imported-by-client":
    "render it from a Server Component, or pass it to the client component as children or a JSX prop; if a barrel makes the importer client code, import the file directly",
  "exports-non-components":
    "move the hooks, helpers and values the file exports into their own module",
  "state-spans-component":
    "keep the state next to the elements that use it, or extract the interactive region into its own component",
  "css-in-js-runtime": "use CSS Modules, Tailwind or another zero-runtime styling approach",
  "non-serializable-prop":
    "pass data instead of behaviour (an id or URL), make the function a Server Action, or keep the component on the client",
  "untyped-boundary":
    "convert the file to TypeScript, or pass primitives instead of objects across the boundary",
  "spread-props": "destructure the specific props the interactive element needs",
  "conditional-hooks-or-returns":
    "call hooks unconditionally at the top of the component, and base early returns on props",
  "class-component": "convert it to a function component",
  "dynamic-import": "import the component statically if you can",
  "render-prop": "pass data and let the child render it, or use children",
  hoc: "remove the wrapper: memo has no effect on Server Components, and in React 19 ref is a regular prop",
  "server-env-difference":
    "rename the variable NEXT_PUBLIC_X if it's public; otherwise read it in a Server Component and pass what the client needs",
  "no-islands":
    'pass --remove-unused-directives (or set removeUnusedDirectives) to have "use client" removed',
  "fully-interactive": "nothing to do: this component belongs on the client",
  "below-threshold": "lower minBytesSaved or minStaticRatio if small splits are worth it to you",
  "measure-failed": "set minBytesSaved to 0, or pass --no-measure",
  "output-exists":
    'set outputExists: "alternate" to use another file name, or remove the existing file',
  "would-create-route": "set clientFileSuffix or islandsDir",
};

/**
 * Explains one file: how it ends up client or server code (the boundary and the shortest import
 * chain), and for a `"use client"` file the run's result with the reasons behind each island, what
 * happens to its imports, and what to do about a skip. Runs the same analysis as `split()`.
 */
export async function explain(options: SplitOptions & { file: string }): Promise<Explanation> {
  const root = realpathSync(path.resolve(options.root ?? process.cwd()));
  const abs = path.resolve(root, options.file);
  if (!existsSync(abs)) throw new ConfigError(`explain(): ${options.file} does not exist`);
  if (statSync(abs).isDirectory())
    throw new ConfigError(`explain(): ${options.file} is a directory; pass a file`);
  const file = realpathSync(abs);
  const components = new Map<string, PlanTrace>();
  const report = await runSplit({
    ...options,
    write: false,
    root,
    trace: { file: path.relative(root, file), components },
  });
  const { run } = report;
  const { graph } = run;
  const rel = (f: string) => graph.rel(f);
  const node = graph.nodes.get(file);
  if (!node) return { file: rel(file), kind: "outside-project" };

  const chain = graph.clientChain(file);
  const boundary = node.directive === "use client" ? file : chain[0];
  const explanation: Explanation = {
    file: rel(file),
    kind:
      node.directive === "use client" ? "client-boundary" : chain.length > 0 ? "client" : "server",
    ...(node.directive ? { directive: node.directive } : {}),
    ...(graph.importersOf(file).some((e) => e.kind !== "type") ? {} : { unimported: true }),
    ...(chain.length > 1 ? { clientChain: chain.map(rel) } : {}),
  };
  if (boundary) explanation.renderedBy = serverImporters(graph, boundary);
  if (node.directive === "use client" && isIslandFile(file, run.config))
    explanation.note = `its name ends in ${run.config.clientFileSuffix}, so it's treated as a generated island: runs never analyse or change it`;
  if (!node.directive && node.inProgram) explanation.serverUse = serverUse(run, file);

  const result = report.files.find((f) => f.file === rel(file));
  if (result) {
    explanation.result = result;
    if (components.size > 0) {
      explanation.components = [...components].map(([name, trace]) => ({
        name,
        anchors: trace.anchors,
        steps: trace.steps,
      }));
    }
    if (isChange(result)) explanation.imports = importFates(run, file, result, report.files);
    const suggestion = result.skipped && suggest(run, file, result.skipped.code);
    if (suggestion) explanation.suggestion = suggestion;
  }
  return explanation;
}

/** Server modules that import `file`, with the line of the import. */
function serverImporters(graph: ModuleGraph, file: string): { file: string; line: number }[] {
  return graph
    .importersOf(file)
    .filter((e) => e.kind !== "type" && !graph.isClient(e.from))
    .map((e) => ({ file: graph.rel(e.from), line: e.line }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function serverUse(run: RunContext, file: string): Explanation["serverUse"] {
  const whole = run.moduleSafety.check(file);
  const program = run.loaded.project.getProgram().compilerObject;
  const sf = program.getSourceFile(file);
  const checker = program.getTypeChecker();
  const symbol = sf && checker.getSymbolAtLocation(sf);
  const exports = symbol
    ? checker
        .getExportsOfModule(symbol)
        .filter((s) => {
          const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
          return (target.flags & ts.SymbolFlags.Value) !== 0;
        })
        .map((s) => ({ name: s.getName(), ...run.moduleSafety.check(file, s.getName()) }))
    : [];
  return { ...whole, exports };
}

/** What a change does to each module the file imported. */
function importFates(
  run: RunContext,
  file: string,
  result: FileResult,
  all: FileResult[],
): NonNullable<Explanation["imports"]> {
  const { graph, root } = run;
  const islandPath = Object.keys(result.outputs).find((f) => f !== result.file);
  const islandText = islandPath ? result.outputs[islandPath] : undefined;
  const keyOf = (e: ModuleEdge) =>
    e.to
      ? graph.rel(e.to)
      : e.external && e.external.kind !== "unresolved"
        ? e.external.packageName
        : undefined;
  const islandModules = new Set(
    islandPath && islandText
      ? graph.edgesOfText(path.join(root, islandPath), islandText).flatMap((e) => keyOf(e) ?? [])
      : [],
  );
  // The client graph with every change of the run applied.
  const changes = all.filter(isChange).map((f) => {
    const island = Object.keys(f.outputs).find((o) => o !== f.file);
    const text = island ? f.outputs[island] : undefined;
    return {
      file: path.join(root, f.file),
      ...(island && text ? { island: { file: path.join(root, island), text } } : {}),
    };
  });
  const after = graph.clientGraphAfter(changes);
  const fates = new Map<string, NonNullable<Explanation["imports"]>[number]["fate"]>();
  for (const edge of graph.edgesFrom(file)) {
    if (edge.kind === "type") continue;
    const key = keyOf(edge);
    if (!key || fates.has(key)) continue;
    const kind = edge.external?.kind;
    if (kind === "react" || kind === "react-dom" || kind === "framework") continue;
    if (kind === "stylesheet" || kind === "css-module" || kind === "asset" || kind === "json")
      continue;
    if (islandModules.has(key)) fates.set(key, "island");
    else if (kind === "builtin" || kind === "server-only-marker") fates.set(key, "server-only");
    else if (edge.to ? after.files.has(edge.to) : after.packages.has(key))
      fates.set(key, "still-shipped");
    else fates.set(key, "leaves-client");
  }
  return [...fates].map(([module, fate]) => ({ module, fate }));
}

/** A fix for a skip; for a context provider, the extraction it takes. */
function suggest(run: RunContext, file: string, code: SkipCode): string | undefined {
  if (code === "context-provider") {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const context = /(?:const|let)\s+(\w+)\s*=\s*(?:React\.)?createContext\b/.exec(text)?.[1];
    const base = path.basename(file, path.extname(file));
    // Already the extracted provider: the extraction would only repeat itself.
    if (/Provider$/.test(base))
      return `this file is the provider, so there's nothing left to extract: keep it a "use client" file, render <${base}> from a Server Component (a layout) around server-rendered children, and they stay on the server`;
    const providerFile = `${base}Provider${path.extname(file)}`;
    const names = context
      ? `${context} and the component that renders <${context}.Provider> (with the state that feeds its value)`
      : "the context and its provider (with the state that feeds its value)";
    return `move ${names} into a "use client" file of their own (${path.join(path.dirname(graphRel(run, file)), providerFile)}), export a ${base}Provider({ children }) component from it, render <${base}Provider> from ${base} around the server-rendered content, and run auto-server-split again: ${base} can then be split or become a Server Component`;
  }
  return FIXES[code];
}

function graphRel(run: RunContext, file: string): string {
  return run.graph.rel(file);
}
