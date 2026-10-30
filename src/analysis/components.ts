import path from "node:path";
import { ts } from "ts-morph";
import type { AnalysisContext } from "./context.js";
import { locOf } from "./context.js";
import { isJsxElementLike, symbolOfRef } from "./refs.js";
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
  /**
   * The nodes the component's symbol is declared on, which importers resolve to: the function or
   * variable declaration, plus an `export default memo(X)` that exports it.
   */
  declarations: ts.Node[];
  /**
   * Edits that remove `memo()` / `forwardRef()` around the component in the server file (see
   * {@link transparentWrapper}). Empty for an unwrapped component.
   */
  unwrap: TextEdit[];
  /** The `ref` parameter of a function inside `forwardRef()`, unused and dropped by `unwrap`. */
  droppedRef?: ts.ParameterDeclaration;
};

/**
 * Replaces `[start, end)` of the original text with `text` (an insertion when they're equal).
 * `keep`: original text the edit's new text refers to, whose references still count as used.
 */
export type TextEdit = {
  start: number;
  end: number;
  text: string;
  keep?: { start: number; end: number };
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

type WrapperKind = "memo" | "forwardRef";

/** `memo` / `forwardRef` from React, called as `memo(...)` or `React.memo(...)`. */
function wrapperKind(callee: ts.Expression, facts: FileFacts): WrapperKind | undefined {
  const head = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  if (!ts.isIdentifier(head)) return undefined;
  const info = facts.classifyRef(head);
  if (info.kind !== "import" || info.usage.special !== "hoc") return undefined;
  const { binding } = info;
  if (binding.module.kind !== "external" || binding.module.info.kind !== "react") return undefined;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : binding.imported;
  return name === "memo" || name === "forwardRef" ? name : undefined;
}

/** `memo(forwardRef(fn))` -> the calls (outermost first) and what they wrap. */
function wrapperChain(
  expr: ts.Expression,
  facts: FileFacts,
): { calls: { call: ts.CallExpression; kind: WrapperKind }[]; inner: ts.Expression } {
  const calls: { call: ts.CallExpression; kind: WrapperKind }[] = [];
  let inner = expr;
  for (;;) {
    const e = ts.isParenthesizedExpression(inner) ? inner.expression : inner;
    if (!ts.isCallExpression(e)) break;
    const kind = wrapperKind(e.expression, facts);
    const [first] = e.arguments;
    if (!kind || !first) break;
    calls.push({ call: e, kind });
    inner = first;
  }
  return { calls, inner };
}

/**
 * The callee heads (`memo`, `React`) of the wrapper calls a component declaration may be wrapped in:
 * a module-level `const X = memo(...)` or `export default memo(...)`. Whether unwrapping is safe is
 * decided by {@link analyzeFileShape}; these markers aren't a reason to skip the file on their own.
 */
export function wrapperCalleeHeads(sf: ts.SourceFile, facts: FileFacts): Set<ts.Node> {
  const heads = new Set<ts.Node>();
  const collect = (expr: ts.Expression | undefined) => {
    if (!expr) return;
    for (const { call } of wrapperChain(expr, facts).calls) {
      const callee = call.expression;
      heads.add(ts.isPropertyAccessExpression(callee) ? callee.expression : callee);
    }
  };
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement)) collect(statement.expression);
    else if (ts.isVariableStatement(statement))
      for (const decl of statement.declarationList.declarations) collect(decl.initializer);
  }
  return heads;
}

/**
 * Edits that remove `memo()` / `forwardRef()` around a component, or why it can't be done. Every
 * importer of a split file is a Server Component that renders it as `<X />` (checkImporters), so it
 * never re-renders on the client, where `memo` would matter, and never passes a ref (Server
 * Components can't), so a `forwardRef` whose function ignores its `ref` is plain function too.
 * `forwardRef<T, P>`'s props type moves onto the parameter, which it typed through the call.
 */
function transparentWrapper(
  ctx: AnalysisContext,
  name: string,
  calls: { call: ts.CallExpression; kind: WrapperKind }[],
  inner: ts.Expression,
): Outcome<{ edits: TextEdit[]; droppedRef?: ts.ParameterDeclaration }> {
  const { sf, checker } = ctx;
  const edits: TextEdit[] = [];
  for (const { call, kind } of calls) {
    const wrapped = call.arguments[0] as ts.Expression;
    const compare = call.arguments[1];
    const extra = call.arguments[kind === "memo" ? 2 : 1];
    if (extra || (compare && !ts.isArrowFunction(compare) && !ts.isFunctionExpression(compare))) {
      return skip(
        "hoc",
        `${name} is wrapped in ${kind}() with arguments this version doesn't drop`,
        locOf(ctx, call),
      );
    }
    edits.push({ start: call.getStart(sf), end: wrapped.getStart(sf), text: "" });
    edits.push({ start: wrapped.getEnd(), end: call.getEnd(), text: "" });
  }
  const fn = ts.isParenthesizedExpression(inner) ? inner.expression : inner;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return ok({ edits });
  const [props, ref] = fn.parameters;
  const forwardRefCall = calls.find((c) => c.kind === "forwardRef")?.call;
  if (ref) {
    if (!forwardRefCall || fn.parameters.length > 2)
      return skip("unsupported-pattern", `${name} takes more than one parameter`, locOf(ctx, fn));
    if (!ts.isIdentifier(ref.name) || isReferenced(ref.name, fn, checker)) {
      return skip(
        "hoc",
        `${name} uses the ref that forwardRef() passes it; a Server Component can't receive a ref, so this version doesn't split it`,
        locOf(ctx, ref),
      );
    }
    edits.push({ start: (props as ts.ParameterDeclaration).getEnd(), end: ref.getEnd(), text: "" });
  }
  if (props && !props.type && !ctx.isJs) {
    const typeArg = forwardRefCall?.typeArguments?.[1];
    if (!typeArg) {
      return skip(
        "hoc",
        `${name}'s props are typed by the ${calls[0]?.kind ?? "wrapper"}() call around it; add a type to its parameter to split it`,
        locOf(ctx, props),
      );
    }
    // `props => ...` needs parentheses once typed; the type goes before a default value.
    const bare = ts.isArrowFunction(fn) && sf.text[fn.getStart(sf)] !== "(";
    const start = props.getStart(sf);
    const nameEnd = (props.questionToken ?? props.name).getEnd();
    const typed = `${sf.text.slice(start, nameEnd)}: ${typeArg.getText(sf)}${sf.text.slice(nameEnd, props.getEnd())}`;
    edits.push({
      start,
      end: props.getEnd(),
      text: bare ? `(${typed})` : typed,
      keep: { start: typeArg.getStart(sf), end: typeArg.getEnd() },
    });
  }
  return ok(ref ? { edits, droppedRef: ref } : { edits });
}

function isReferenced(name: ts.Identifier, scope: ts.Node, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(name);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // symbolOfRef: `{ ref }` shorthand refers to the variable, not the property.
    if (ts.isIdentifier(n) && n !== name && symbolOfRef(checker, n) === symbol) found = true;
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** The name an anonymous default-exported component goes by: its file's (`Badge.tsx` -> Badge). */
function anonymousName(file: string): string {
  const base = path
    .basename(file, path.extname(file))
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Z][A-Za-z0-9]*$/.test(base) ? base : "Component";
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
  /** `export default memo(X)`: X is resolved once every component is known. */
  const wrappedDefaults: {
    statement: ts.ExportAssignment;
    name: string;
    calls: { call: ts.CallExpression; kind: WrapperKind }[];
  }[] = [];
  /** `export const Y = memo(X)` or `const Y = X`: another name for X, resolved the same way. */
  const aliases: {
    statement: ts.VariableStatement;
    decl: ts.VariableDeclaration;
    alias: string;
    target: string;
    calls: { call: ts.CallExpression; kind: WrapperKind }[];
    exported: boolean;
  }[] = [];
  const aliasOf = new Map<string, ComponentInfo>();

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
          name: name === "default" ? anonymousName(ctx.file) : name,
          fn: statement,
          statement,
          exported: exported ? (hasDefaultModifier(statement) ? "default" : "named") : "none",
          declarations: [statement],
          unwrap: [],
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
        // `const X = memo(function X() {...})`: the component is the function inside the wrappers.
        const chain = decl.initializer
          ? wrapperChain(decl.initializer, facts)
          : { calls: [], inner: undefined };
        const init = chain.inner;
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
          const unwrap =
            chain.calls.length > 0
              ? transparentWrapper(ctx, name, chain.calls, fn)
              : ok<{ edits: TextEdit[]; droppedRef?: ts.ParameterDeclaration }>({ edits: [] });
          if (!unwrap.ok) return unwrap;
          components.push({
            name,
            fn,
            statement,
            exported: exported ? "named" : "none",
            declarations: [decl],
            unwrap: unwrap.value.edits,
            ...(unwrap.value.droppedRef ? { droppedRef: unwrap.value.droppedRef } : {}),
          });
          isComponentStatement = true;
          continue;
        }
        if (
          name &&
          init &&
          ts.isIdentifier(init) &&
          isCapitalized(name) &&
          isConst &&
          statement.declarationList.declarations.length === 1
        ) {
          aliases.push({
            statement,
            decl,
            alias: name,
            target: init.text,
            calls: chain.calls,
            exported,
          });
          isComponentStatement = true;
          continue;
        }
        if (name && decl.initializer && isCapitalized(name)) {
          const hoc = hocCallName(decl.initializer, sf);
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
      // `export default memo(Stat)` or `export default memo(function Stat() {...})`.
      const chain = wrapperChain(expr, facts);
      const inner = chain.inner;
      if (chain.calls.length > 0 && ts.isIdentifier(inner)) {
        wrappedDefaults.push({ statement, name: inner.text, calls: chain.calls });
        defaultExportName = inner.text;
        continue;
      }
      // `export default memo(function Stat() {...})`, or a bare `export default (props) => ...`.
      if ((ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) && returnsJsx(inner)) {
        const name =
          (ts.isFunctionExpression(inner) && inner.name?.text) || anonymousName(ctx.file);
        if (inner.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
          return skip("unsupported-pattern", `${name} is an async function`, locOf(ctx, statement));
        const unwrap =
          chain.calls.length > 0
            ? transparentWrapper(ctx, name, chain.calls, inner)
            : ok<{ edits: TextEdit[]; droppedRef?: ts.ParameterDeclaration }>({ edits: [] });
        if (!unwrap.ok) return unwrap;
        components.push({
          name,
          fn: inner,
          statement,
          exported: "default",
          declarations: [statement],
          unwrap: unwrap.value.edits,
          ...(unwrap.value.droppedRef ? { droppedRef: unwrap.value.droppedRef } : {}),
        });
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

  for (const { statement, name, calls } of wrappedDefaults) {
    const component = components.find((c) => c.name === name);
    if (!component) {
      return skip(
        "exports-non-components",
        `the default export wraps ${name}, which is not a component`,
        locOf(ctx, statement),
      );
    }
    const unwrap = transparentWrapper(ctx, name, calls, statement.expression);
    if (!unwrap.ok) return unwrap;
    component.declarations.push(statement);
    component.unwrap.push(...unwrap.value.edits);
    if (component.exported === "none") component.exported = "default";
  }

  for (const a of aliases) {
    const component = components.find((c) => c.name === a.target);
    if (!component) {
      // Not a component of this file: what such a statement was before aliases were recognised.
      const [first] = a.calls;
      if (first)
        return skip(
          "hoc",
          `${a.alias} is wrapped in ${first.kind}(), and ${a.target} isn't a component declared in this file`,
          locOf(ctx, a.decl),
        );
      if (a.exported)
        return skip(
          "exports-non-components",
          `exports ${a.alias}, which is not a component`,
          locOf(ctx, a.decl),
        );
      moduleDecls.push({
        statement: a.statement,
        names: [a.alias],
        kind: "const",
        exported: false,
      });
      continue;
    }
    const unwrap =
      a.calls.length > 0
        ? transparentWrapper(ctx, a.alias, a.calls, a.decl.initializer as ts.Expression)
        : ok<{ edits: TextEdit[]; droppedRef?: ts.ParameterDeclaration }>({ edits: [] });
    if (!unwrap.ok) return unwrap;
    component.declarations.push(a.decl);
    component.unwrap.push(...unwrap.value.edits);
    if (a.exported && component.exported === "none") component.exported = "named";
    aliasOf.set(a.alias, component);
  }

  // Names exported through `export { X }` / `export default X` must be components or types.
  for (const [name, node] of exportedNames) {
    const component = components.find((c) => c.name === name) ?? aliasOf.get(name);
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
