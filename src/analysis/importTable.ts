import path from "node:path";
import { ts } from "ts-morph";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { ExternalModuleInfo } from "../project/moduleTypes.js";
import type { Directive } from "./directives.js";
import type { BindingClass, FrameworkAdapter } from "./framework.js";

export type ImportedModule =
  | { kind: "project"; file: string; directive: Directive | undefined }
  | { kind: "external"; info: ExternalModuleInfo };

export type ImportBinding = {
  local: string;
  /** "default", "*" (namespace) or the exported name. */
  imported: string;
  symbol: ts.Symbol;
  declaration: ts.ImportDeclaration;
  node: ts.ImportSpecifier | ts.ImportClause | ts.NamespaceImport;
  typeOnly: boolean;
  module: ImportedModule;
  specifier: string;
};

export type ImportTable = {
  bindings: ImportBinding[];
  bySymbol: Map<ts.Symbol, ImportBinding>;
  declarations: ts.ImportDeclaration[];
  sideEffectImports: ts.ImportDeclaration[];
};

/** Special React/framework APIs that decide a whole-file skip rather than a client/server split. */
export type SpecialApi = "context" | "class" | "hoc" | "lazy" | "dynamic" | "css-in-js";

export type UsageClass = { cls: BindingClass; special?: SpecialApi; reason: string };

const REACT_NEUTRAL = new Set([
  "default",
  "*",
  "Fragment",
  "Suspense",
  "StrictMode",
  "Profiler",
  "Children",
  "cloneElement",
  "isValidElement",
  "createElement",
  "cache",
  "version",
]);
const REACT_SPECIAL: Record<string, SpecialApi> = {
  createContext: "context",
  Component: "class",
  PureComponent: "class",
  memo: "hoc",
  forwardRef: "hoc",
  lazy: "lazy",
};
const REACT_DOM_NEUTRAL = new Set([
  "preload",
  "preinit",
  "preconnect",
  "prefetchDNS",
  "preloadModule",
  "preinitModule",
]);

export function buildImportTable(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  graph: ModuleGraph,
): ImportTable {
  const file = path.resolve(sf.fileName);
  const table: ImportTable = {
    bindings: [],
    bySymbol: new Map(),
    declarations: [],
    sideEffectImports: [],
  };
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    table.declarations.push(statement);
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) {
      table.sideEffectImports.push(statement);
      continue;
    }
    const edge = graph.edgeFor(file, specifier);
    const module: ImportedModule = edge?.to
      ? { kind: "project", file: edge.to, directive: graph.nodes.get(edge.to)?.directive }
      : {
          kind: "external",
          info: edge?.external ?? {
            specifier,
            packageName: specifier,
            kind: "unresolved",
            detail: "not in module graph",
          },
        };
    const add = (
      node: ImportBinding["node"],
      nameNode: ts.Identifier,
      imported: string,
      typeOnly: boolean,
    ) => {
      const symbol = checker.getSymbolAtLocation(nameNode);
      if (!symbol) return;
      const binding: ImportBinding = {
        local: nameNode.text,
        imported,
        symbol,
        declaration: statement,
        node,
        typeOnly: typeOnly || clause.isTypeOnly,
        module,
        specifier,
      };
      table.bindings.push(binding);
      table.bySymbol.set(symbol, binding);
    };
    if (clause.name) add(clause, clause.name, "default", false);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) add(bindings, bindings.name, "*", false);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        add(element, element.name, (element.propertyName ?? element.name).text, element.isTypeOnly);
      }
    }
  }
  return table;
}

export type ProjectModuleSafety = (file: string) => { safe: boolean; reason?: string };

/**
 * How using `binding` (optionally `binding.member`) behaves in code that will run as a Server
 * Component. `asJsxTag` is true when the binding is rendered as `<Binding />`.
 */
export function classifyImportUsage(
  binding: ImportBinding,
  member: string | undefined,
  asJsxTag: boolean,
  framework: FrameworkAdapter,
  projectSafety: ProjectModuleSafety,
): UsageClass {
  const name =
    binding.imported === "default" || binding.imported === "*"
      ? (member ?? binding.imported)
      : binding.imported;
  const from = binding.specifier;
  const mod = binding.module;

  if (mod.kind === "project") {
    if (mod.directive === "use client") {
      return asJsxTag
        ? { cls: "client-reference", reason: `${binding.local} is a Client Component from ${from}` }
        : {
            cls: "client-only",
            reason: `${binding.local} comes from the "use client" module ${from}`,
          };
    }
    if (mod.directive === "use server")
      return { cls: "server-action", reason: `${binding.local} is a Server Action` };
    const safety = projectSafety(mod.file);
    return safety.safe
      ? { cls: "neutral", reason: `${from} is server-safe` }
      : {
          cls: "client-only",
          reason: `${binding.local} from ${from} is client-only (${safety.reason ?? "uses client APIs"})`,
        };
  }

  const info = mod.info;
  switch (info.kind) {
    case "react": {
      const special = REACT_SPECIAL[name];
      if (special) return { cls: "client-only", special, reason: `React.${name}` };
      if (REACT_NEUTRAL.has(name)) return { cls: "neutral", reason: `React.${name}` };
      return { cls: "client-only", reason: `React.${name} only works in Client Components` };
    }
    case "react-dom":
      return REACT_DOM_NEUTRAL.has(name)
        ? { cls: "neutral", reason: `ReactDOM.${name}` }
        : { cls: "client-only", reason: `ReactDOM.${name} only works in the browser` };
    case "framework": {
      const rule = framework.classifyModule(from);
      if (!rule) return { cls: "client-only", reason: `${from} is not understood` };
      if (rule.kind === "dynamic-import")
        return { cls: "client-only", special: "dynamic", reason: `${from}` };
      if (rule.kind === "css-in-js")
        return { cls: "client-only", special: "css-in-js", reason: `${from}` };
      const cls = rule.classify(name);
      return { cls, reason: `${name} from ${from}` };
    }
    case "css-in-js":
      return {
        cls: "client-only",
        special: "css-in-js",
        reason: `${from} is a runtime CSS-in-JS library`,
      };
    case "use-client-entry":
      return asJsxTag
        ? { cls: "client-reference", reason: `${binding.local} is a Client Component from ${from}` }
        : {
            cls: "client-only",
            reason: `${binding.local} comes from the "use client" package ${from}`,
          };
    case "client-list":
      return {
        cls: "client-only",
        reason: `${from} is a client-only package${info.detail ? ` (${info.detail})` : ""}`,
      };
    case "client-only-marker":
      return { cls: "client-only", reason: `${from} is marked client-only` };
    case "react-unknown":
      return {
        cls: "client-only",
        reason: info.detail ?? `${from} depends on React and isn't known to be server-safe`,
      };
    case "unresolved":
      return {
        cls: "client-only",
        reason: `${from} could not be resolved${info.detail ? ` (${info.detail})` : ""}`,
      };
    case "builtin":
    case "server-only-marker":
      return { cls: "server-only", reason: `${from} only works on the server` };
    case "server-safe-list":
    case "neutral":
    case "json":
    case "asset":
    case "css-module":
    case "stylesheet":
      return { cls: "neutral", reason: `${from} is server-safe` };
  }
}
