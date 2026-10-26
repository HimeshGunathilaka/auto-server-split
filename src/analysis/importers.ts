import { ts } from "ts-morph";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { ComponentInfo } from "./components.js";
import { componentDeclarationNode } from "./components.js";
import { lineCol } from "./context.js";
import { getModuleDirective, hasUseServerBody } from "./directives.js";
import { forEachValueRef } from "./refs.js";
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
  // Names each queued module exports the components under, for importers outside the program,
  // which are checked without type information.
  const ownSf = program.getSourceFile(file);
  const exportNames = new Map([[file, ownSf ? exportedValueNames(ownSf) : new Set<string>()]]);

  const recordActionProps = (
    tag: ts.Identifier,
    sf: ts.SourceFile,
    isAction: (expr: ts.Expression) => boolean,
  ) => {
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
      const action = expr !== undefined && isAction(expr);
      actionUsage.set(name, (actionUsage.get(name) ?? true) && action);
    }
  };

  while (queue.length > 0) {
    const target = queue.shift() as string;
    const names = exportNames.get(target) ?? new Set<string>();
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
        const what = graph.generated.has(importer)
          ? "the client island this run generates"
          : "client";
        return skip("imported-by-client", `imported by ${rel} (${what}${via})`);
      }
      if (edge.kind === "dynamic") {
        return skip("dynamic-import", `loaded with import() by ${rel}`);
      }
      if (edge.kind === "reexport") {
        const sf = node?.inProgram
          ? program.getSourceFile(importer)
          : graph.parseOutsideProgram(importer);
        const forwarded = exportNames.get(importer) ?? new Set<string>();
        const before = forwarded.size;
        if (sf) for (const n of forwardedNames(sf, edge.specifier, names)) forwarded.add(n);
        exportNames.set(importer, forwarded);
        // A barrel reached again with more names is checked again for them.
        if (!visited.has(importer) || forwarded.size > before) {
          visited.add(importer);
          queue.push(importer);
        }
      }

      if (!node?.inProgram) {
        const sf = graph.parseOutsideProgram(importer);
        if (!sf) {
          return skip(
            "unsupported-pattern",
            importer.endsWith(".mdx")
              ? `imported by ${rel}; how MDX files use a component can't be verified`
              : `imported by ${rel}, which is outside the TypeScript project and couldn't be read`,
          );
        }
        const misuse = untypedMisuse(sf, edge.specifier, names, (tag) =>
          recordActionProps(tag, sf, () => false),
        );
        if (misuse) {
          const { line } = lineCol(sf, misuse.getStart(sf));
          if (ts.isCallExpression(misuse)) {
            return skip(
              "unsupported-pattern",
              `${rel}:${line} loads it with require(), so its usage can't be verified`,
            );
          }
          const what = misuse.getText(sf);
          return skip(
            "unsupported-pattern",
            `${what} is used as a value in ${rel}:${line}; only <${what} /> usage can be verified`,
          );
        }
        continue;
      }

      importers.add(importer);
      const sf = program.getSourceFile(importer);
      if (!sf) {
        return skip(
          "unsupported-pattern",
          `imported by ${rel}, which couldn't be loaded to verify how it uses the component`,
        );
      }
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
            if (isJsxTagPosition(n))
              recordActionProps(n, sf, (expr) => isServerActionReference(expr, checker));
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

/** The names a module exports values under (`"default"` for the default export). */
function exportedValueNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
  const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false);
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) names.add("default");
    else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      exported(statement)
    ) {
      if (isDefault(statement)) names.add("default");
      else if (statement.name) names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const decl of statement.declarationList.declarations)
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements)
        if (!element.isTypeOnly) names.add(element.name.text);
    }
  }
  return names;
}

/** Names a barrel re-exports `names` of `specifier` under (`export *`, `export { a as b }`). */
function forwardedNames(sf: ts.SourceFile, specifier: string, names: Set<string>): string[] {
  const out: string[] = [];
  for (const statement of sf.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== specifier
    )
      continue;
    const clause = statement.exportClause;
    if (!clause) out.push(...[...names].filter((n) => n !== "default"));
    else if (ts.isNamespaceExport(clause)) out.push(clause.name.text);
    else
      for (const element of clause.elements)
        if (!element.isTypeOnly && names.has((element.propertyName ?? element.name).text))
          out.push(element.name.text);
  }
  return out;
}

/**
 * The importer check for a file outside the TypeScript program, done syntactically: what it imports
 * from `specifier` under one of `names` may only be rendered as JSX, used in a type or re-exported.
 * Without scope information any other identifier with the same name counts as a use, which can
 * only make the check stricter. `require()` of the module can't be followed, so it counts too.
 */
function untypedMisuse(
  sf: ts.SourceFile,
  specifier: string,
  names: Set<string>,
  onJsxTag: (tag: ts.Identifier) => void,
): ts.Node | undefined {
  const tracked = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression) &&
      statement.moduleReference.expression.text === specifier
    ) {
      namespaces.add(statement.name.text);
      continue;
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== specifier
    )
      continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name && names.has("default")) tracked.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else if (bindings) {
      for (const element of bindings.elements)
        if (!element.isTypeOnly && names.has((element.propertyName ?? element.name).text))
          tracked.add(element.name.text);
    }
  }

  let misuse: ts.Node | undefined;
  const findRequire = (n: ts.Node): void => {
    if (misuse) return;
    const [arg] = ts.isCallExpression(n) ? n.arguments : [];
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "require" &&
      arg &&
      ts.isStringLiteralLike(arg) &&
      arg.text === specifier
    ) {
      misuse = n;
      return;
    }
    ts.forEachChild(n, findRequire);
  };
  findRequire(sf);
  forEachValueRef(sf, (id) => {
    if (misuse) return;
    if (tracked.has(id.text)) {
      if (isJsxTagPosition(id)) onJsxTag(id);
      else misuse = id;
    } else if (namespaces.has(id.text)) {
      const parent = id.parent;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== id) misuse = id;
      else if (names.has(parent.name.text)) {
        if (ts.isIdentifier(parent.name) && isJsxTagPosition(parent.name)) onJsxTag(parent.name);
        else misuse = parent;
      }
    }
  });
  return misuse;
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
