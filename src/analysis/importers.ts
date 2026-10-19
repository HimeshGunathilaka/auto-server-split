import { ts } from "ts-morph";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { ComponentInfo } from "./components.js";
import { lineCol } from "./context.js";
import type { Outcome } from "./skip.js";
import { ok, skip } from "./skip.js";

function isInTypePosition(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isTypeNode(parent) && !ts.isExpressionWithTypeArguments(parent)) return true;
    if (ts.isTypeQueryNode(parent)) return true;
    if (ts.isStatement(parent) || ts.isSourceFile(parent)) return false;
    current = parent;
  }
  return false;
}

function isJsxTagPosition(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) node = node.parent;
  const parent = node.parent;
  return (
    (ts.isJsxOpeningElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isJsxClosingElement(parent)) &&
    parent.tagName === node
  );
}

function componentDeclarationNode(component: ComponentInfo): ts.Node {
  return ts.isFunctionDeclaration(component.fn) ? component.fn : component.fn.parent;
}

/**
 * Spec 5.2: every module that imports the file (directly or through barrels) must be a server
 * module, and must only render the components as JSX, so they can safely become Server Components.
 * Returns the importer files whose diagnostics the self-check should compare.
 */
export function checkImporters(
  program: ts.Program,
  graph: ModuleGraph,
  file: string,
  components: ComponentInfo[],
): Outcome<{ importers: string[] }> {
  const checker = program.getTypeChecker();
  const componentDecls = new Set(components.map(componentDeclarationNode));
  const importers = new Set<string>();
  const queue = [file];
  const visited = new Set<string>([file]);

  while (queue.length > 0) {
    const target = queue.shift() as string;
    const edges = graph
      .importersOf(target)
      .filter((e) => e.kind !== "type")
      .sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
    for (const edge of edges) {
      const importer = edge.from;
      const rel = graph.rel(importer);
      const node = graph.nodes.get(importer);
      if (graph.isClient(importer)) {
        const root = graph.clientRootOf(importer);
        const via = root && root !== importer ? `, reached from ${graph.rel(root)}` : "";
        return skip("imported-by-client", `imported by ${rel} (client${via})`);
      }
      if (!node?.inProgram) {
        return skip(
          "imported-by-client",
          `imported by ${rel}, which is outside the TypeScript project, so its usage can't be verified`,
        );
      }
      if (edge.kind === "dynamic") {
        return skip("dynamic-import", `loaded with import() by ${rel}`);
      }
      importers.add(importer);
      if (edge.kind === "reexport" && !visited.has(importer)) {
        visited.add(importer);
        queue.push(importer);
      }
      const sf = program.getSourceFile(importer);
      if (!sf) continue;
      let misuse: ts.Identifier | undefined;
      const visit = (n: ts.Node): void => {
        if (misuse) return;
        if (ts.isIdentifier(n)) {
          const symbol = checker.getSymbolAtLocation(n);
          const resolved =
            symbol && symbol.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(symbol)
              : symbol;
          if (resolved?.declarations?.some((d) => componentDecls.has(d))) {
            const p = n.parent;
            const benign =
              ts.isImportSpecifier(p) ||
              ts.isImportClause(p) ||
              ts.isExportSpecifier(p) ||
              ts.isNamespaceImport(p) ||
              isJsxTagPosition(n) ||
              isInTypePosition(n);
            if (!benign) misuse = n;
          }
          return;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (misuse) {
        const { line } = lineCol(sf, misuse.getStart(sf));
        return skip(
          "unsupported-pattern",
          `${misuse.text} is used as a value in ${rel}:${line}; only <${misuse.text} /> usage can be verified`,
        );
      }
    }
  }
  return ok({ importers: [...importers] });
}
