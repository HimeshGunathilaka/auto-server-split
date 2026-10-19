import { ts } from "ts-morph";
import type { ModuleDecl } from "../analysis/components.js";
import type { ImportBinding, ImportTable } from "../analysis/importTable.js";
import { containsRange } from "../analysis/refs.js";

export type TypeDeps = {
  /** Import bindings needed only as types. */
  imports: Set<ImportBinding>;
  /** Module-level declarations of this file needed by the island (types, or values used via typeof). */
  moduleDecls: Set<ModuleDecl>;
  /** `import type { Name } from "spec"` lines synthesised from `import("spec").Name` in printed types. */
  synthetic: Map<string, Set<string>>;
};

export type TypeRefFailure = { message: string; node?: ts.Node };

/** Leftmost identifiers of every type reference under `node`. */
function typeReferenceHeads(node: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const head = (name: ts.EntityName | ts.Expression): ts.Identifier | undefined => {
    let current: ts.Node = name;
    while (ts.isQualifiedName(current) || ts.isPropertyAccessExpression(current)) {
      current = ts.isQualifiedName(current) ? current.left : current.expression;
    }
    return ts.isIdentifier(current) ? current : undefined;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n)) {
      const id = head(n.typeName);
      if (id) out.push(id);
    } else if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)) {
      const id = head(n.expression);
      if (id) out.push(id);
    } else if (ts.isTypeQueryNode(n)) {
      const id = head(n.exprName);
      if (id) out.push(id);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

export class TypeRefCollector {
  readonly deps: TypeDeps = { imports: new Set(), moduleDecls: new Set(), synthetic: new Map() };

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly checker: ts.TypeChecker,
    private readonly imports: ImportTable,
    private readonly moduleDecls: ModuleDecl[],
    /** Nodes whose declarations travel into the island (their local type names are in scope there). */
    private readonly islandContent: ts.Node[],
  ) {}

  private classify(
    symbol: ts.Symbol | undefined,
    name: string,
    node: ts.Node | undefined,
  ): TypeRefFailure | undefined {
    if (!symbol) return undefined; // unresolved names are globals or errors already present in the input
    const binding = this.imports.bySymbol.get(symbol);
    if (binding) {
      this.deps.imports.add(binding);
      return undefined;
    }
    const decl = symbol.declarations?.[0];
    if (!decl) return undefined;
    if (decl.getSourceFile() !== this.sf) return undefined; // global / ambient
    if (this.islandContent.some((c) => containsRange(c, decl))) return undefined;
    let top: ts.Node = decl;
    while (top.parent && top.parent !== this.sf) top = top.parent;
    const moduleDecl = this.moduleDecls.find((d) => d.statement === top);
    if (moduleDecl) {
      if (!this.deps.moduleDecls.has(moduleDecl)) {
        this.deps.moduleDecls.add(moduleDecl);
        if (!moduleDecl.exported) {
          const failure = this.collectFromNode(moduleDecl.statement);
          if (failure) return failure;
        }
      }
      return undefined;
    }
    return {
      message: `the type \`${name}\` is declared inside the component and can't be referenced from the island`,
      node,
    };
  }

  /** Type names used inside a node that moves into the island. */
  collectFromNode(node: ts.Node, exclude: readonly ts.Node[] = []): TypeRefFailure | undefined {
    for (const id of typeReferenceHeads(node)) {
      if (exclude.some((e) => containsRange(e, id))) continue;
      const failure = this.classify(this.checker.getSymbolAtLocation(id), id.text, id);
      if (failure) return failure;
    }
    return undefined;
  }

  /**
   * Type names inside a printed type (from checker.typeToString at `location`). `import("x").Y`
   * forms become `import type { Y } from "x"` when x is a package name.
   */
  collectFromPrinted(printed: string, location: ts.Node): { text: string } | TypeRefFailure {
    let text = printed;
    const importTypeRe = /import\("([^"]+)"\)\.([A-Za-z_$][\w$]*)/g;
    for (const match of printed.matchAll(importTypeRe)) {
      const spec = match[1] ?? "";
      const name = match[2] ?? "";
      if (spec.startsWith(".") || spec.startsWith("/")) {
        return { message: `can't name the type \`${name}\` from ${spec} in the generated file` };
      }
      const names = this.deps.synthetic.get(spec) ?? new Set<string>();
      names.add(name);
      this.deps.synthetic.set(spec, names);
      text = text.replace(match[0], name);
    }
    const parsed = ts.createSourceFile(
      "__type.ts",
      `type __T = ${text};`,
      ts.ScriptTarget.Latest,
      true,
    );
    const inScope = new Map<string, ts.Symbol>();
    for (const symbol of this.checker.getSymbolsInScope(
      location,
      ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias,
    )) {
      if (!inScope.has(symbol.getName())) inScope.set(symbol.getName(), symbol);
    }
    for (const id of typeReferenceHeads(parsed)) {
      if (id.text === "__T") continue;
      if (
        ts.isTypeQueryNode(id.parent) ||
        (ts.isQualifiedName(id.parent) && ts.isTypeQueryNode(id.parent.parent))
      ) {
        return {
          message: `a prop's type refers to the value \`${id.text}\` (typeof), which can't be named in the generated file`,
        };
      }
      if ([...this.deps.synthetic.values()].some((s) => s.has(id.text))) continue;
      const symbol = inScope.get(id.text);
      if (!symbol) {
        return {
          message: `can't name the type \`${id.text}\` in the generated file (it isn't imported here)`,
        };
      }
      const failure = this.classify(symbol, id.text, undefined);
      if (failure) return failure;
    }
    return { text };
  }
}
