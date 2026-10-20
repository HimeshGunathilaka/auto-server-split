import { ts } from "ts-morph";
import type { AnalysisContext } from "./context.js";
import { locOf } from "./context.js";
import { isJsxElementLike } from "./refs.js";
import type { Outcome } from "./skip.js";
import { ok, skip } from "./skip.js";
import type { FileFacts } from "./taint.js";

export type ComponentFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

export type ComponentInfo = {
  name: string;
  fn: ComponentFunction;
  /** The module-level statement that declares the component. */
  statement: ts.Statement;
  exported: "default" | "named" | "none";
};

/** A module-level declaration other than imports and components (helpers, constants, types). */
export type ModuleDecl = {
  statement: ts.Statement;
  names: string[];
  kind: "function" | "const" | "type" | "class" | "enum";
  exported: boolean;
  /** Set when this declaration is a component of the file (used to copy/move whole components). */
  component?: ComponentInfo;
};

export type FileShape = {
  components: ComponentInfo[];
  moduleDecls: ModuleDecl[];
  /** A ModuleDecl view of every component, so components can be copied like helpers. */
  componentDecls: Map<ComponentInfo, ModuleDecl>;
};

/** The node a component's symbol is declared on (function declaration or variable declarator). */
export function componentDeclarationNode(component: ComponentInfo): ts.Node {
  return ts.isFunctionDeclaration(component.fn) ? component.fn : component.fn.parent;
}

function isCapitalized(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false)
  );
}

/** True if the function returns JSX (directly, not from a nested function). */
function returnsJsx(fn: ComponentFunction): boolean {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return containsJsx(fn.body);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(n) && n !== fn) return;
    if (ts.isReturnStatement(n) && n.expression && containsJsx(n.expression)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return found;
}

function containsJsx(node: ts.Node): boolean {
  if (isJsxElementLike(node)) return true;
  return ts.forEachChild(node, (c) => (containsJsx(c) ? true : undefined)) ?? false;
}

function hocCallName(expr: ts.Expression, sf: ts.SourceFile): string | undefined {
  if (ts.isCallExpression(expr)) return expr.expression.getText(sf);
  return undefined;
}

/**
 * Splits the module into components and other declarations, enforcing the candidate rules:
 * only components and types are exported, and nothing runs at module level that would
 * behave differently on the server.
 */
export function analyzeFileShape(ctx: AnalysisContext, facts: FileFacts): Outcome<FileShape> {
  const { sf } = ctx;
  const components: ComponentInfo[] = [];
  const moduleDecls: ModuleDecl[] = [];
  const exportedNames = new Map<string, ts.Node>();
  let defaultExportName: string | undefined;

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue; // directives

    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      moduleDecls.push({
        statement,
        names: [statement.name.text],
        kind: "type",
        exported: hasExportModifier(statement),
      });
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? (hasDefaultModifier(statement) ? "default" : "");
      const exported = hasExportModifier(statement);
      if ((isCapitalized(name) || name === "default") && returnsJsx(statement)) {
        if (
          statement.asteriskToken ||
          statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
        ) {
          return skip(
            "unsupported-pattern",
            `${name} is an async or generator function`,
            locOf(ctx, statement),
          );
        }
        components.push({
          name: name === "default" ? "Component" : name,
          fn: statement,
          statement,
          exported: exported ? (hasDefaultModifier(statement) ? "default" : "named") : "none",
        });
      } else {
        if (exported) {
          const why = isCapitalized(name)
            ? "doesn't return JSX, so it isn't treated as a component"
            : "is not a component";
          return skip(
            "exports-non-components",
            `exports ${name || "a function"}, which ${why}`,
            locOf(ctx, statement),
          );
        }
        moduleDecls.push({
          statement,
          names: name ? [name] : [],
          kind: "function",
          exported: false,
        });
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const exported = hasExportModifier(statement);
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      let isComponentStatement = false;
      for (const decl of statement.declarationList.declarations) {
        const name = ts.isIdentifier(decl.name) ? decl.name.text : undefined;
        const init = decl.initializer;
        const fn =
          init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
        if (name && isCapitalized(name) && fn && returnsJsx(fn)) {
          if (statement.declarationList.declarations.length > 1) {
            return skip(
              "unsupported-pattern",
              `${name} is declared together with other variables`,
              locOf(ctx, decl),
            );
          }
          if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
            return skip("unsupported-pattern", `${name} is an async function`, locOf(ctx, decl));
          }
          components.push({ name, fn, statement, exported: exported ? "named" : "none" });
          isComponentStatement = true;
          continue;
        }
        if (name && init && isCapitalized(name)) {
          const hoc = hocCallName(init, sf);
          if (hoc && /(^|\.)(memo|forwardRef)$/.test(hoc)) {
            return skip(
              "hoc",
              `${name} is wrapped in ${hoc}(), which this version doesn't split`,
              locOf(ctx, decl),
            );
          }
        }
        if (exported) {
          return skip(
            "exports-non-components",
            `exports ${name ?? "a value"}, which is not a component`,
            locOf(ctx, decl),
          );
        }
      }
      if (isComponentStatement) continue; // a `const X = () => <jsx />` component, not a module value
      if (!isConst) {
        return skip(
          "unsupported-pattern",
          "declares module-level `let`/`var` state, which would be shared across requests on the server",
          locOf(ctx, statement),
        );
      }
      const names = statement.declarationList.declarations.flatMap((d) =>
        ts.isIdentifier(d.name) ? [d.name.text] : [],
      );
      if (statement.declarationList.declarations.some((d) => !ts.isIdentifier(d.name))) {
        return skip(
          "unsupported-pattern",
          "uses a destructuring declaration at module level",
          locOf(ctx, statement),
        );
      }
      moduleDecls.push({ statement, names, kind: "const", exported: false });
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const extendsComponent = statement.heritageClauses?.some((h) =>
        h.types.some((t) => /(^|\.)(Component|PureComponent)$/.test(t.expression.getText(sf))),
      );
      if (extendsComponent)
        return skip(
          "class-component",
          `${statement.name?.text ?? "a class"} is a class component`,
          locOf(ctx, statement),
        );
      if (hasExportModifier(statement)) {
        return skip(
          "exports-non-components",
          `exports the class ${statement.name?.text ?? ""}`.trim(),
          locOf(ctx, statement),
        );
      }
      moduleDecls.push({
        statement,
        names: statement.name ? [statement.name.text] : [],
        kind: "class",
        exported: false,
      });
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      if (hasExportModifier(statement)) {
        return skip(
          "exports-non-components",
          `exports the enum ${statement.name.text}`,
          locOf(ctx, statement),
        );
      }
      moduleDecls.push({ statement, names: [statement.name.text], kind: "enum", exported: false });
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const expr = statement.expression;
      if (ts.isIdentifier(expr)) {
        defaultExportName = expr.text;
        exportedNames.set(expr.text, statement);
        continue;
      }
      const hoc = hocCallName(expr, sf);
      if (hoc)
        return skip(
          "hoc",
          `the default export is wrapped in ${hoc}(), which this version doesn't split`,
          locOf(ctx, statement),
        );
      return skip(
        "exports-non-components",
        "the default export is not a component",
        locOf(ctx, statement),
      );
    }

    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier) {
        if (statement.isTypeOnly) continue;
        return skip(
          "exports-non-components",
          "re-exports another module; its exports can't be verified",
          locOf(ctx, statement),
        );
      }
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (statement.isTypeOnly || element.isTypeOnly) continue;
          const local = (element.propertyName ?? element.name).text;
          exportedNames.set(local, element);
          if (element.name.text === "default") defaultExportName = local;
        }
      }
      continue;
    }

    return skip(
      "unsupported-pattern",
      "has a module-level statement that runs on import",
      locOf(ctx, statement),
    );
  }

  // Names exported through `export { X }` / `export default X` must be components or types.
  for (const [name, node] of exportedNames) {
    const component = components.find((c) => c.name === name);
    if (component) {
      if (component.exported === "none")
        component.exported = name === defaultExportName ? "default" : "named";
      continue;
    }
    const decl = moduleDecls.find((d) => d.names.includes(name));
    if (decl?.kind === "type") continue;
    return skip(
      "exports-non-components",
      `exports ${name}, which is not a component`,
      locOf(ctx, node),
    );
  }

  // Module-level code (outside functions) must not touch browser APIs or call hooks.
  for (const decl of moduleDecls) {
    if (decl.kind !== "const" && decl.kind !== "class") continue;
    const markers = facts.scanMarkers(
      decl.statement,
      (n) => ts.isFunctionLike(n) || ts.isClassLike(n),
    );
    const browser = markers.find(
      (m) => m.kind === "browser-global" || m.kind === "hook" || m.kind === "nondeterministic",
    );
    if (browser) {
      return skip(
        "unsupported-pattern",
        `module-level code uses ${browser.detail}; it would run on the server after the split`,
        locOf(ctx, browser.node),
      );
    }
  }

  if (components.length === 0) {
    return skip("unsupported-pattern", "no function component found in this file", undefined);
  }
  const componentDecls = new Map<ComponentInfo, ModuleDecl>();
  for (const component of components) {
    componentDecls.set(component, {
      statement: component.statement,
      names: [component.name],
      kind: "function",
      exported: component.exported !== "none",
      component,
    });
  }
  return ok({ components, moduleDecls, componentDecls });
}
