import { ts } from "ts-morph";
import type { ExternalKind } from "./project/moduleTypes.js";
import type { RunContext } from "./split.js";

/** One `"use client"` file and what it pulls into the browser bundle. */
export type Boundary = {
  file: string;
  /** The Server Components that render it, with the import's line. */
  renderedBy: { file: string; line: number }[];
  /** Client modules that import it as well: there it's just client code, not a boundary. */
  clientImporters: string[];
  /** Project modules it brings into the client bundle (not counting other boundaries). */
  modules: string[];
  /** Packages it, or those modules, import. */
  packages: string[];
  /**
   * For a `"use client"` file that only re-exports: the modules it re-exports that don't need the
   * directive (they could be Server Components if imported directly).
   */
  barrel?: { serverSafe: string[] };
};

export type BoundaryGraph = { boundaries: Boundary[] };

/** Packages that ship code to the browser (React and Next ship with every page anyway). */
const SHIPPING: ReadonlySet<ExternalKind> = new Set([
  "client-list",
  "neutral",
  "server-safe-list",
  "react-unknown",
  "use-client-entry",
  "css-in-js",
]);

/** The client boundaries of the project: every `"use client"` module (`--graph`). */
export function boundaryGraph(run: RunContext): BoundaryGraph {
  const { graph } = run;
  const boundaries: Boundary[] = [];
  for (const node of [...graph.nodes.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    if (node.directive !== "use client" || graph.generated.has(node.file)) continue;
    const importers = graph.importersOf(node.file).filter((e) => e.kind !== "type");
    const modules = new Set<string>();
    const packages = new Set<string>();
    const pending = [node.file];
    const seen = new Set<string>();
    for (let file = pending.pop(); file; file = pending.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (file !== node.file) modules.add(graph.rel(file));
      for (const edge of graph.edgesFrom(file)) {
        if (edge.kind === "type") continue;
        if (edge.external && SHIPPING.has(edge.external.kind))
          packages.add(edge.external.packageName);
        const target = edge.to ? graph.nodes.get(edge.to) : undefined;
        if (!edge.to || !target || target.directive) continue;
        pending.push(edge.to);
      }
    }
    const boundary: Boundary = {
      file: graph.rel(node.file),
      renderedBy: importers
        .filter((e) => !graph.isClient(e.from))
        .map((e) => ({ file: graph.rel(e.from), line: e.line }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
      clientImporters: [
        ...new Set(importers.filter((e) => graph.isClient(e.from)).map((e) => graph.rel(e.from))),
      ].sort(),
      modules: [...modules].sort(),
      packages: [...packages].sort(),
    };
    const barrel = barrelExports(run, node.file);
    if (barrel) boundary.barrel = barrel;
    boundaries.push(boundary);
  }
  return { boundaries };
}

/**
 * For a module whose only statements are the directive and re-exports: the re-exported modules
 * that would be server-safe on their own.
 */
function barrelExports(run: RunContext, file: string): Boundary["barrel"] | undefined {
  const sf = run.loaded.project.getSourceFile(file)?.compilerNode;
  if (!sf) return undefined;
  const statements = sf.statements.filter(
    (s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)),
  );
  if (statements.length === 0) return undefined;
  if (!statements.every((s) => ts.isExportDeclaration(s) && s.moduleSpecifier)) return undefined;
  const serverSafe = new Set<string>();
  for (const statement of statements as ts.ExportDeclaration[]) {
    const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
    const edge = run.graph.edgeFor(file, spec);
    if (!edge?.to || run.graph.nodes.get(edge.to)?.directive) continue;
    if (run.moduleSafety.check(edge.to).safe) serverSafe.add(run.graph.rel(edge.to));
  }
  return { serverSafe: [...serverSafe].sort() };
}
