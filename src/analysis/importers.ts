import { ts } from "ts-morph";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { ComponentInfo } from "./components.js";
import { componentDeclarationNode } from "./components.js";
import { lineCol } from "./context.js";
import { getModuleDirective, hasUseServerBody } from "./directives.js";
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

/**
 * Every module that imports the file (directly or through barrels) must be a server
 * module, and must only render the components as JSX, so they can safely become Server Components.
 * Returns the importer files whose diagnostics the self-check should compare.
 */
export function checkImporters(
  program: ts.Program,
  graph: ModuleGraph,
  file: string,
  components: ComponentInfo[],
): Outcome<{ importers: string[]; serverActionProps: Set<string> }> {
  const checker = program.getTypeChecker();
  // prop name -> true while every JSX usage seen so far passes a Server Action for it.
  const actionUsage = new Map<string, boolean>();
  let sawSpread = false;
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
      if (!sf) {
        return skip(
          "imported-by-client",
          `imported by ${rel}, which couldn't be loaded to verify how it uses the component`,
        );
      }
      let misuse: ts.Identifier | undefined;
      const recordActionProps = (tag: ts.Identifier) => {
        let tagNode: ts.Node = tag;
        if (ts.isPropertyAccessExpression(tagNode.parent)) tagNode = tagNode.parent;
        const element = tagNode.parent;
        if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) return;
        for (const attr of element.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attr)) {
            sawSpread = true;
            continue;
          }
          const name = attr.name.getText(sf);
          const init = attr.initializer;
          const expr = init && ts.isJsxExpression(init) ? init.expression : undefined;
          const isAction = expr !== undefined && isServerActionReference(expr, checker);
          actionUsage.set(name, (actionUsage.get(name) ?? true) && isAction);
        }
      };
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
            if (isJsxTagPosition(n)) recordActionProps(n);
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
  const serverActionProps = new Set<string>();
  if (!sawSpread) for (const [name, all] of actionUsage) if (all) serverActionProps.add(name);
  return ok({ importers: [...importers], serverActionProps });
}

/** True if `expr` names a Server Action: an export of a "use server" module or a "use server" function. */
function isServerActionReference(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
  const symbol = checker.getSymbolAtLocation(e);
  const resolved =
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const decl = resolved?.valueDeclaration ?? resolved?.declarations?.[0];
  if (!decl) return false;
  const sf = decl.getSourceFile();
  if (sf.isDeclarationFile) return false;
  if (getModuleDirective(sf).directive === "use server") return true;
  if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) {
    return hasUseServerBody(decl);
  }
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return hasUseServerBody(init);
  }
  return false;
}
