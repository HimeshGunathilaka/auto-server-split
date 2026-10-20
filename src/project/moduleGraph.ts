import { readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { ts } from "ts-morph";
import { getModuleDirective } from "../analysis/directives.js";
import type { LoadedProject } from "./loadProject.js";
import { IGNORE_GLOBS, projectSourceFiles } from "./loadProject.js";
import type { ModuleEdge, ModuleNode, EdgeKind } from "./moduleTypes.js";
import type { PackageClassifier } from "./packages.js";

const SOURCE_EXT_RE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/**
 * Import graph over every project module (the whole tsconfig program plus JS/MDX files under the
 * root that the program doesn't cover), with client reachability computed from "use client" roots.
 */
export class ModuleGraph {
  readonly nodes = new Map<string, ModuleNode>();
  private readonly importers = new Map<string, ModuleEdge[]>();
  /** Client-graph membership: file -> the module it was first reached from (null for "use client" roots). */
  private readonly clientParent = new Map<string, string | null>();

  constructor(readonly root: string) {}

  addNode(node: ModuleNode): void {
    this.nodes.set(node.file, node);
  }

  finalize(): void {
    for (const node of this.nodes.values()) {
      for (const edge of node.edges) {
        if (!edge.to) continue;
        const list = this.importers.get(edge.to) ?? [];
        list.push(edge);
        this.importers.set(edge.to, list);
      }
    }
    const queue: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.directive === "use client") {
        this.clientParent.set(node.file, null);
        queue.push(node.file);
      }
    }
    while (queue.length > 0) {
      const file = queue.shift() as string;
      for (const edge of this.nodes.get(file)?.edges ?? []) {
        if (!edge.to || edge.kind === "type" || this.clientParent.has(edge.to)) continue;
        this.clientParent.set(edge.to, file);
        queue.push(edge.to);
      }
    }
  }

  importersOf(file: string): ModuleEdge[] {
    return this.importers.get(file) ?? [];
  }

  isClient(file: string): boolean {
    return this.clientParent.has(file);
  }

  /** The "use client" module that pulls `file` into the client graph, if it's not a root itself. */
  clientRootOf(file: string): string | undefined {
    let current: string | null | undefined = file;
    let guard = 0;
    while (current && guard++ < 10_000) {
      const parent = this.clientParent.get(current);
      if (parent === null) return current;
      current = parent;
    }
    return undefined;
  }

  edgesFrom(file: string): ModuleEdge[] {
    return this.nodes.get(file)?.edges ?? [];
  }

  edgeFor(file: string, specifier: string): ModuleEdge | undefined {
    return this.edgesFrom(file).find((e) => e.specifier === specifier && e.kind !== "dynamic");
  }

  rel(file: string): string {
    return path.relative(this.root, file).split(path.sep).join("/");
  }
}

type RawImport = { specifier: string; kind: EdgeKind; line: number };

function collectImports(sf: ts.SourceFile): RawImport[] {
  const out: RawImport[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const typeOnly = statement.importClause?.isTypeOnly === true;
      out.push({
        specifier: statement.moduleSpecifier.text,
        kind: typeOnly ? "type" : "static",
        line: lineOf(statement),
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      out.push({
        specifier: statement.moduleSpecifier.text,
        kind: statement.isTypeOnly ? "type" : "reexport",
        line: lineOf(statement),
      });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const expr = statement.moduleReference.expression;
      if (ts.isStringLiteral(expr))
        out.push({ specifier: expr.text, kind: "static", line: lineOf(statement) });
    }
  }
  // import("x"), require("x") and next/dynamic(() => import("x")) anywhere in the file.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          out.push({ specifier: arg.text, kind: "dynamic", line: lineOf(node) });
        else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          out.push({ specifier: arg.text, kind: "static", line: lineOf(node) });
        }
      }
    }
    if (ts.isImportTypeNode(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const MDX_IMPORT_RE = /^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

export function buildModuleGraph(
  loaded: LoadedProject,
  classifier: PackageClassifier,
): ModuleGraph {
  const graph = new ModuleGraph(loaded.root);
  // Resolve with allowJs so edges into JS files are never lost, whatever the user's tsconfig says.
  const options: ts.CompilerOptions = { ...loaded.compilerOptions, allowJs: true };
  const host: ts.ModuleResolutionHost = ts.sys;
  const cache = ts.createModuleResolutionCache(loaded.root, (f) => f, options);

  const resolve = (specifier: string, from: string): string | undefined => {
    const result = ts.resolveModuleName(specifier, from, options, host, cache).resolvedModule;
    if (!result || result.isExternalLibraryImport) return undefined;
    const resolved = path.resolve(result.resolvedFileName);
    if (resolved.includes(`${path.sep}node_modules${path.sep}`) || resolved.endsWith(".d.ts"))
      return undefined;
    return resolved;
  };

  const addFile = (
    file: string,
    sf: ts.SourceFile | undefined,
    inProgram: boolean,
    mdxText?: string,
  ) => {
    const raw: RawImport[] = sf
      ? collectImports(sf)
      : [...(mdxText ?? "").matchAll(MDX_IMPORT_RE)].map((m) => ({
          specifier: m[1] ?? "",
          kind: "static" as const,
          line: (mdxText ?? "").slice(0, m.index).split("\n").length,
        }));
    const edges: ModuleEdge[] = raw.map((imp) => {
      const to = resolve(imp.specifier, file);
      return {
        from: file,
        specifier: imp.specifier,
        kind: imp.kind,
        to,
        external: to ? undefined : classifier.classify(imp.specifier, file),
        line: imp.line,
      };
    });
    graph.addNode({
      file,
      directive: sf ? getModuleDirective(sf).directive : undefined,
      inProgram,
      edges,
    });
  };

  if (loaded.lazyFileNames) {
    // Lazy projects: parse every tsconfig file syntactically (no type checking needed for imports),
    // then follow imports the way TypeScript builds the program: an imported TS file is always part
    // of it, a JS file only with allowJs (edges resolve with allowJs on, so check the project's own).
    const allowJs = loaded.compilerOptions.allowJs === true;
    const queue = [...loaded.lazyFileNames];
    for (const file of queue) {
      if (graph.nodes.has(file) || !SOURCE_EXT_RE.test(file)) continue;
      if (file.endsWith(".d.ts") || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const kind = /\.(tsx|jsx)$/.test(file)
        ? ts.ScriptKind.TSX
        : /\.(js|mjs|cjs)$/.test(file)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
      addFile(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind), true);
      for (const edge of graph.nodes.get(file)?.edges ?? []) {
        if (edge.to && (allowJs || !/\.(jsx?|mjs|cjs)$/.test(edge.to))) queue.push(edge.to);
      }
    }
  } else {
    for (const sf of projectSourceFiles(loaded)) addFile(path.resolve(sf.fileName), sf, true);
  }

  // Files the program doesn't cover can still import a component; they count as importers.
  const extra = fg.sync(["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,mdx}"], {
    cwd: loaded.root,
    ignore: [...IGNORE_GLOBS, "**/*.d.ts"],
    absolute: true,
  });
  for (const file of extra.map((f) => path.resolve(f))) {
    if (graph.nodes.has(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (file.endsWith(".mdx")) addFile(file, undefined, false, text);
    else if (SOURCE_EXT_RE.test(file)) {
      const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      addFile(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind), false);
    }
  }

  graph.finalize();
  return graph;
}
