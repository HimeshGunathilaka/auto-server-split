import { ts } from "ts-morph";
import type { ComponentInfo, FileShape, ModuleDecl } from "./components.js";
import type { AnalysisContext } from "./context.js";
import { locOf } from "./context.js";
import { hasUseServerBody } from "./directives.js";
import type { ImportBinding, UsageClass } from "./importTable.js";
import {
  bindingIdentifiers,
  containsRange,
  forEachValueRef,
  isIntrinsicTagName,
  isJsxElementLike,
  isTypeSyntax,
  mapCallOf,
  stripParens,
  symbolOfRef,
  tagNameText,
} from "./refs.js";
import { pickReadFields } from "./fields.js";
import type { PickedProp } from "./mongoose.js";
import { isMongooseLike, pickMongooseFields } from "./mongoose.js";
import { checkSerializable, isCallableType } from "./serializable.js";
import type { Outcome, Skip } from "./skip.js";
import { ok, skip } from "./skip.js";
import type { FileFacts, Marker } from "./taint.js";

export type JsxLike = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

/** One top-level statement of the component body. */
export type Unit = {
  index: number;
  node: ts.Statement;
  kind: "var" | "function" | "hook-call" | "early-return";
  declares: Set<ts.Symbol>;
  localDeps: Set<Unit>;
  moduleDeps: Set<ModuleDecl>;
  markers: Marker[];
  client: boolean;
  /** For early returns: the returned expression. */
  returned?: ts.Expression;
  /**
   * For a `let`: the statements right after it that only assign the variable (`x = ...`, or in
   * `if`/`else` branches). The variable isn't assigned anywhere else, so after them it behaves like
   * a `const`; the unit is the declaration and these together.
   */
  extra?: ts.Statement[];
};

/** A unit's statements: its node, then (for a `let`) the assignments that complete it. */
export function unitNodes(unit: Unit): ts.Statement[] {
  return unit.extra ? [unit.node, ...unit.extra] : [unit.node];
}

export type JNode = {
  id: number;
  node: JsxLike;
  parent: JNode | undefined;
  children: JNode[];
  rootIndex: number;
  /** Functions between the parent JNode (or the render root) and this node, outermost first. */
  fnBetween: ts.SignatureDeclaration[];
  depth: number;
};

type Origin =
  | { kind: "param"; symbol: ts.Symbol }
  | { kind: "local"; symbol: ts.Symbol; unit: Unit }
  | { kind: "inner"; symbol: ts.Symbol; declaration: ts.Declaration }
  | { kind: "module"; symbol: ts.Symbol; decl: ModuleDecl }
  | { kind: "component"; symbol: ts.Symbol; component: ComponentInfo }
  | { kind: "import"; binding: ImportBinding; usage: UsageClass }
  | { kind: "browser-global"; name: string }
  | { kind: "global" }
  | { kind: "unknown" };

export type PropInfo = {
  name: string;
  symbol: ts.Symbol;
  type: ts.Type;
  /** A reference inside the island, used as the location for type printing and narrowing. */
  refNode: ts.Identifier;
  /**
   * Only the fields the island reads, as an object built on the server: for a plain object the
   * island reads part of, and for Mongoose/ObjectId values (`mongoose.autoSerialize`).
   */
  picked?: PickedProp;
};

export type IslandPlan = {
  name: string;
  root: JNode;
  rootTag: string;
  /** `key` attribute moved from a mapped root onto the island usage. */
  keyAttr: ts.JsxAttribute | undefined;
  /** Body statements the island needs, in source order. */
  units: Unit[];
  props: PropInfo[];
  /** Import bindings used in value positions inside the island. */
  valueImports: Set<ImportBinding>;
  /** Module-level declarations that must be copied into the island file. */
  moduleDecls: Set<ModuleDecl>;
  /**
   * Static subtrees inside the island that stay on the server and are passed in as JSX props
   * ("donut" pattern): `children` for a single slot, otherwise `slot1`, `slot2`, ...
   */
  slots: { j: JNode; name: string }[];
  line: number;
  /**
   * An island that renders nothing and only runs client statements no element uses (an effect
   * that syncs `document.title`). It is rendered as the last child of `root`, the component's
   * returned element, instead of replacing it.
   */
  effects?: boolean;
};

export type ComponentPlan = {
  component: ComponentInfo;
  islands: IslandPlan[];
  /** Body statements removed from the server component. */
  removedUnits: Set<Unit>;
  /** Module declarations no longer used by the server file (copied into the island file). */
  movedModuleDecls: Set<ModuleDecl>;
  staticRatio: number;
  jsxTotal: number;
};

/** React hooks whose result is the same for every caller under the same provider. */
const REACT_SHARED_CONTEXT_HOOKS = ["useContext", "use"];

/** React hooks that never schedule effects (anything else, custom hooks included, might). */
const NO_EFFECT_HOOKS = new Set([
  "useState",
  "useReducer",
  "useRef",
  "useMemo",
  "useCallback",
  "useContext",
  "useId",
  "useDeferredValue",
  "useTransition",
  "useDebugValue",
  "use",
]);

/** Elements an island that renders nothing can't be added to (no children, or text-only ones). */
const NO_EXTRA_CHILD_TAGS = new Set([
  "html",
  "head",
  "title",
  "style",
  "script",
  "noscript",
  "template",
  "textarea",
  "option",
  "iframe",
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/** Lowest common ancestor in the JSX tree, or undefined if the nodes live in different render roots. */
export function lowestCommonAncestor(nodes: JNode[]): JNode | undefined {
  const [first, ...rest] = nodes;
  if (!first) return undefined;
  let lca: JNode | undefined = first;
  for (const node of rest) {
    if (!lca) return undefined;
    if (node.rootIndex !== lca.rootIndex) return undefined;
    let a: JNode | undefined = lca;
    let b: JNode | undefined = node;
    while (a && b && a.depth > b.depth) a = a.parent;
    while (a && b && b.depth > a.depth) b = b.parent;
    while (a && b && a !== b) {
      a = a.parent;
      b = b.parent;
    }
    lca = a;
  }
  return lca;
}

function isAncestorOrSelf(ancestor: JNode, node: JNode): boolean {
  let current: JNode | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

export function islandBaseName(componentName: string, rootTag: string): string {
  return `${componentName}${pascal(rootTag) || "Island"}`;
}

/**
 * Plans the split of one component: which JSX subtrees become islands, which statements move with
 * them, and which values cross the boundary as props.
 */
/**
 * Why a component's islands have the shape they have (`--explain`): the elements that use
 * client-only code and what they use, then each grouping decision, in order.
 */
export type PlanTrace = {
  anchors: { element: string; line: number; reasons: string[] }[];
  steps: string[];
};

type PlanOptions = {
  /** Filled in with the planning decisions when given. */
  trace?: PlanTrace;
  /** Component props that every importer passes a Server Action for (see checkImporters). */
  serverActionProps?: ReadonlySet<string>;
  /** Other components of the file that move wholesale into the island file (client references). */
  wholesale?: ReadonlySet<ComponentInfo>;
};

export function planComponent(
  ctx: AnalysisContext,
  facts: FileFacts,
  shape: FileShape,
  component: ComponentInfo,
  options: PlanOptions = {},
): Outcome<ComponentPlan> {
  const { checker, sf } = ctx;
  const fn = component.fn;
  const body = fn.body;
  if (!body) return skip("unsupported-pattern", `${component.name} has no body`, locOf(ctx, fn));
  // An unwrapped forwardRef() function's unused `ref` parameter is dropped from the server file.
  const params = fn.parameters.filter((p) => p !== component.droppedRef);
  if (params.length > 1) {
    return skip(
      "unsupported-pattern",
      `${component.name} takes more than one parameter`,
      locOf(ctx, fn),
    );
  }

  // ---- parameters ---------------------------------------------------------------------------
  const paramSymbols = new Set<ts.Symbol>();
  const serverActionParams = new Set<ts.Symbol>();
  for (const param of params) {
    for (const id of bindingIdentifiers(param.name)) {
      const symbol = checker.getSymbolAtLocation(id);
      if (symbol) paramSymbols.add(symbol);
    }
    if (ts.isObjectBindingPattern(param.name)) {
      for (const element of param.name.elements) {
        const propName = element.propertyName ?? element.name;
        if (!ts.isIdentifier(propName) || !ts.isIdentifier(element.name)) continue;
        if (!options.serverActionProps?.has(propName.text)) continue;
        const symbol = checker.getSymbolAtLocation(element.name);
        if (symbol) serverActionParams.add(symbol);
      }
    }
  }

  // ---- body units and render roots ------------------------------------------------------------
  const units: Unit[] = [];
  const renderRoots: ts.Expression[] = [];
  const earlyReturnConditions: ts.Expression[] = [];
  const symbolToUnit = new Map<ts.Symbol, Unit>();

  const newUnit = (node: ts.Statement, kind: Unit["kind"]): Unit => {
    const unit: Unit = {
      index: units.length,
      node,
      kind,
      declares: new Set(),
      localDeps: new Set(),
      moduleDeps: new Set(),
      markers: [],
      client: false,
    };
    units.push(unit);
    return unit;
  };

  if (!ts.isBlock(body)) {
    renderRoots.push(stripParens(body));
  } else {
    const statements = body.statements;
    let sawReturn = false;
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i] as ts.Statement;
      if (ts.isEmptyStatement(statement)) continue;
      if (sawReturn)
        return skip(
          "unsupported-pattern",
          "has statements after the final return",
          locOf(ctx, statement),
        );
      if (ts.isReturnStatement(statement)) {
        if (!statement.expression)
          return skip("unsupported-pattern", "returns nothing", locOf(ctx, statement));
        renderRoots.push(stripParens(statement.expression));
        sawReturn = true;
        continue;
      }
      if (ts.isIfStatement(statement)) {
        const then = statement.thenStatement;
        const ret = ts.isReturnStatement(then)
          ? then
          : ts.isBlock(then) &&
              then.statements.length === 1 &&
              ts.isReturnStatement(then.statements[0] as ts.Statement)
            ? (then.statements[0] as ts.ReturnStatement)
            : undefined;
        if (!ret || statement.elseStatement || !ret.expression) {
          return skip(
            "unsupported-pattern",
            "has an `if` statement other than a simple early return",
            locOf(ctx, statement),
          );
        }
        const unit = newUnit(statement, "early-return");
        unit.returned = stripParens(ret.expression);
        renderRoots.push(unit.returned);
        earlyReturnConditions.push(statement.expression);
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
          const group = letGroup(checker, statement, statements.slice(i + 1), body);
          if (typeof group === "string")
            return skip("unsupported-pattern", group, locOf(ctx, statement));
          const unit = newUnit(statement, "var");
          if (group.extra.length > 0) unit.extra = group.extra;
          unit.declares.add(group.symbol);
          symbolToUnit.set(group.symbol, unit);
          i += group.extra.length;
          continue;
        }
        const unit = newUnit(statement, "var");
        for (const decl of statement.declarationList.declarations) {
          for (const id of bindingIdentifiers(decl.name)) {
            const symbol = checker.getSymbolAtLocation(id);
            if (symbol) {
              unit.declares.add(symbol);
              symbolToUnit.set(symbol, unit);
            }
          }
        }
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const unit = newUnit(statement, "function");
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (symbol) {
          unit.declares.add(symbol);
          symbolToUnit.set(symbol, unit);
        }
        continue;
      }
      if (ts.isExpressionStatement(statement)) {
        const expr = stripParens(statement.expression);
        if (ts.isCallExpression(expr) && facts.isHookCall(expr)) {
          newUnit(statement, "hook-call");
          continue;
        }
        return skip(
          "unsupported-pattern",
          "has a statement with side effects in the component body (only declarations, hook calls and early returns are supported)",
          locOf(ctx, statement),
        );
      }
      return skip(
        "unsupported-pattern",
        `has a \`${ts.SyntaxKind[statement.kind]}\` in the component body`,
        locOf(ctx, statement),
      );
    }
    if (renderRoots.length === 0)
      return skip("unsupported-pattern", `${component.name} never returns JSX`, locOf(ctx, fn));
  }

  // ---- origins ----------------------------------------------------------------------------------
  const moduleDeclByStatement = new Map<ts.Statement, ModuleDecl>();
  for (const decl of shape.moduleDecls) moduleDeclByStatement.set(decl.statement, decl);
  const componentStatements = new Set(shape.components.map((c) => c.statement));

  const topLevelStatement = (node: ts.Node): ts.Statement | undefined => {
    let current: ts.Node | undefined = node;
    while (current && current.parent !== sf) current = current.parent;
    return current as ts.Statement | undefined;
  };

  const originOf = (id: ts.Identifier): Origin => {
    const info = facts.classifyRef(id);
    switch (info.kind) {
      case "import":
        return { kind: "import", binding: info.binding, usage: info.usage };
      case "browser-global":
        return { kind: "browser-global", name: info.name };
      case "global":
        return { kind: "global" };
      case "unknown":
        return { kind: "unknown" };
      case "file": {
        const { symbol, declaration } = info;
        if (paramSymbols.has(symbol)) return { kind: "param", symbol };
        const unit = symbolToUnit.get(symbol);
        if (unit) return { kind: "local", symbol, unit };
        if (containsRange(fn, declaration)) return { kind: "inner", symbol, declaration };
        const top = topLevelStatement(declaration);
        if (top && componentStatements.has(top)) {
          const target = shape.components.find((c) => c.statement === top);
          if (target?.declarations.includes(declaration))
            return { kind: "component", symbol, component: target };
          // A name declared inside another component of the file (its params, locals).
          return { kind: "inner", symbol, declaration };
        }
        const decl = top ? moduleDeclByStatement.get(top) : undefined;
        if (decl) return { kind: "module", symbol, decl };
        return { kind: "unknown" };
      }
    }
  };

  // ---- module declaration taint (helpers, constants) ---------------------------------------------
  const clientModuleDecls = new Set<ModuleDecl>();
  const moduleDeclDeps = new Map<ModuleDecl, Set<ModuleDecl>>();
  for (const decl of shape.moduleDecls) {
    if (decl.kind === "type") continue;
    const deps = new Set<ModuleDecl>();
    forEachValueRef(decl.statement, (id) => {
      const origin = originOf(id);
      if (origin.kind === "module" && origin.decl !== decl) deps.add(origin.decl);
    });
    moduleDeclDeps.set(decl, deps);
    if (facts.scanMarkers(decl.statement).length > 0) clientModuleDecls.add(decl);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [decl, deps] of moduleDeclDeps) {
      if (clientModuleDecls.has(decl)) continue;
      if ([...deps].some((d) => clientModuleDecls.has(d))) {
        clientModuleDecls.add(decl);
        changed = true;
      }
    }
  }

  // ---- unit dependencies, markers, conditional hooks ----------------------------------------------
  let seenEarlyReturn = false;
  for (const unit of units) {
    if (unit.kind === "early-return") seenEarlyReturn = true;
    const scanned =
      unit.kind === "early-return" ? [(unit.node as ts.IfStatement).expression] : unitNodes(unit);
    unit.markers = scanned.flatMap((node) => facts.scanMarkers(node));
    for (const node of scanned) {
      forEachValueRef(node, (id) => {
        const origin = originOf(id);
        if (origin.kind === "local" && origin.unit !== unit) unit.localDeps.add(origin.unit);
        if (origin.kind === "module") unit.moduleDeps.add(origin.decl);
        if (origin.kind === "component")
          unit.markers.push({
            kind: "client-import",
            node: id,
            detail:
              origin.component === component
                ? "recursive component reference"
                : `component ${id.text} used as a value`,
          });
      });
    }
    for (const marker of unit.markers) {
      if (marker.kind !== "hook") continue;
      if (unit.extra?.some((s) => containsRange(s, marker.node))) {
        return skip(
          "conditional-hooks-or-returns",
          `calls ${marker.detail} while computing a \`let\`, possibly conditionally`,
          locOf(ctx, marker.node),
        );
      }
      if (unit.kind === "early-return") {
        return skip(
          "conditional-hooks-or-returns",
          `calls ${marker.detail} inside an early-return condition`,
          locOf(ctx, marker.node),
        );
      }
      if (seenEarlyReturn) {
        return skip(
          "conditional-hooks-or-returns",
          `calls ${marker.detail} after an early return`,
          locOf(ctx, marker.node),
        );
      }
      const conditional = conditionalAncestor(marker.node, unit.node);
      if (conditional) {
        return skip(
          "conditional-hooks-or-returns",
          `calls ${marker.detail} ${conditional}`,
          locOf(ctx, marker.node),
        );
      }
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of units) {
      if (unit.client) continue;
      if (
        unit.markers.length > 0 ||
        [...unit.localDeps].some((d) => d.client) ||
        [...unit.moduleDeps].some((d) => clientModuleDecls.has(d))
      ) {
        unit.client = true;
        changed = true;
      }
    }
  }
  for (const unit of units) {
    if (unit.kind === "early-return" && unit.client) {
      return skip(
        "conditional-hooks-or-returns",
        "returns early based on client-only state, so the server can't decide what to render",
        locOf(ctx, unit.node),
      );
    }
  }

  // ---- JSX tree ---------------------------------------------------------------------------------------
  const jnodes: JNode[] = [];
  const jnodeOf = new Map<ts.Node, JNode>();
  const topJNodes: JNode[][] = renderRoots.map(() => []);

  const build = (
    node: ts.Node,
    parent: JNode | undefined,
    rootIndex: number,
    fns: ts.SignatureDeclaration[],
  ): void => {
    if (isJsxElementLike(node)) {
      const j: JNode = {
        id: jnodes.length,
        node,
        parent,
        children: [],
        rootIndex,
        fnBetween: fns,
        depth: parent ? parent.depth + 1 : 0,
      };
      jnodes.push(j);
      jnodeOf.set(node, j);
      if (parent) parent.children.push(j);
      else topJNodes[rootIndex]?.push(j);
      const inner = (n: ts.Node) => build(n, j, rootIndex, []);
      if (ts.isJsxElement(node)) {
        ts.forEachChild(node.openingElement, inner);
        node.children.forEach(inner);
      } else if (ts.isJsxSelfClosingElement(node)) {
        ts.forEachChild(node, inner);
      } else {
        node.children.forEach(inner);
      }
      return;
    }
    const nextFns = ts.isFunctionLike(node) ? [...fns, node] : fns;
    ts.forEachChild(node, (c) => build(c, parent, rootIndex, nextFns));
  };
  renderRoots.forEach((root, i) => build(root, undefined, i, []));

  const isNestedJsx = (self: ts.Node) => (n: ts.Node) => n !== self && isJsxElementLike(n);

  // Hooks may not be called from JSX.
  for (const root of renderRoots) {
    for (const marker of facts.scanMarkers(root)) {
      if (marker.kind === "hook") {
        return skip(
          "conditional-hooks-or-returns",
          `calls ${marker.detail} inside the returned JSX`,
          locOf(ctx, marker.node),
        );
      }
    }
  }

  // Context providers.
  for (const j of jnodes) {
    if (ts.isJsxFragment(j.node)) continue;
    const tag = ts.isJsxElement(j.node) ? j.node.openingElement.tagName : j.node.tagName;
    if (isIntrinsicTagName(tag)) continue;
    if (
      ts.isPropertyAccessExpression(tag) &&
      (tag.name.text === "Provider" || tag.name.text === "Consumer")
    ) {
      return skip("context-provider", `renders <${tag.getText(sf)}>`, locOf(ctx, tag));
    }
    const tagType = checker.getTypeAtLocation(tag);
    if (tagType.getProperty("Provider") && tagType.getProperty("Consumer")) {
      return skip(
        "context-provider",
        `renders the context <${tag.getText(sf)}> as a provider`,
        locOf(ctx, tag),
      );
    }
  }

  // ---- anchors -----------------------------------------------------------------------------------------
  type Anchor = { j: JNode; reasons: string[]; refs: ts.Identifier[] };
  const anchors: Anchor[] = [];
  const isServerActionRef = (expr: ts.Expression): boolean => {
    const e = stripParens(expr);
    if (!ts.isIdentifier(e)) return false;
    const origin = originOf(e);
    if (origin.kind === "import") return origin.usage.cls === "server-action";
    if (origin.kind === "param") return serverActionParams.has(origin.symbol);
    if (origin.kind === "module" && origin.decl.kind === "function") {
      return (
        ts.isFunctionDeclaration(origin.decl.statement) && hasUseServerBody(origin.decl.statement)
      );
    }
    return false;
  };

  for (const j of jnodes) {
    const reasons: string[] = [];
    const refs: ts.Identifier[] = [];
    const stop = isNestedJsx(j.node);
    forEachValueRef(j.node, (id) => refs.push(id), stop);

    let tagClass: "intrinsic" | "fragment" | "server" | "client-reference" | "client" = "fragment";
    let attributes: ts.JsxAttributes | undefined;
    if (!ts.isJsxFragment(j.node)) {
      const tag = ts.isJsxElement(j.node) ? j.node.openingElement.tagName : j.node.tagName;
      attributes = ts.isJsxElement(j.node) ? j.node.openingElement.attributes : j.node.attributes;
      if (isIntrinsicTagName(tag)) tagClass = "intrinsic";
      else {
        let head: ts.Expression = tag as ts.Expression;
        while (ts.isPropertyAccessExpression(head)) head = head.expression;
        const origin = ts.isIdentifier(head) ? originOf(head) : ({ kind: "unknown" } as Origin);
        if (origin.kind === "import") {
          tagClass =
            origin.usage.cls === "client-reference"
              ? "client-reference"
              : origin.usage.cls === "neutral"
                ? "server"
                : "client";
          if (tagClass === "client") reasons.push(origin.usage.reason);
        } else if (origin.kind === "param" || origin.kind === "local" || origin.kind === "inner") {
          tagClass = "server"; // a dynamic tag; its binding is checked through `refs`
        } else if (origin.kind === "module") {
          tagClass = clientModuleDecls.has(origin.decl) ? "client" : "server";
          if (tagClass === "client")
            reasons.push(`<${tag.getText(sf)}> is built from client-only code`);
        } else if (origin.kind === "component") {
          if (origin.component === component) {
            return skip(
              "unsupported-pattern",
              `${component.name} renders itself recursively`,
              locOf(ctx, tag),
            );
          }
          // Another component of this file: a client reference if it moves to the island file,
          // otherwise it stays a Server Component next to this one.
          tagClass = options.wholesale?.has(origin.component) ? "client-reference" : "server";
        } else {
          tagClass = "client";
          reasons.push(`<${tag.getText(sf)}> can't be proven server-safe`);
        }
      }
      if (
        tagClass === "intrinsic" &&
        ts.isIdentifier(tag) &&
        tag.text === "style" &&
        attributes.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "jsx")
      ) {
        return skip("css-in-js-runtime", "uses <style jsx> (styled-jsx)", locOf(ctx, tag));
      }

      for (const prop of attributes.properties) {
        if (ts.isJsxSpreadAttribute(prop)) {
          const type = checker.getTypeAtLocation(prop.expression);
          const risky = checker
            .getPropertiesOfType(type)
            .find(
              (p) =>
                /^on[A-Z]/.test(p.getName()) ||
                p.getName() === "ref" ||
                isCallableType(checker.getTypeOfSymbolAtLocation(p, prop)),
            );
          if (risky) reasons.push(`spreads a value that can carry \`${risky.getName()}\``);
          else if (
            tagClass === "client-reference" &&
            !checkSerializable(checker, type, { primitivesOnly: ctx.isJs }).ok
          ) {
            reasons.push("spreads non-serializable props into a Client Component");
          }
          continue;
        }
        const name = prop.name.getText(sf);
        if (/^on[A-Z]/.test(name) || name === "ref") {
          reasons.push(`has ${name}`);
          continue;
        }
        const init = prop.initializer;
        if (init && ts.isJsxExpression(init) && init.expression) {
          const expr = init.expression;
          const type = checker.getTypeAtLocation(expr);
          if (isCallableType(type)) {
            const unwrapped = stripParens(expr);
            if (
              (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) &&
              containsJsxNode(unwrapped)
            ) {
              return skip(
                "render-prop",
                `passes a render function to \`${name}\``,
                locOf(ctx, prop),
              );
            }
            const actionOk =
              isServerActionRef(expr) &&
              (tagClass !== "intrinsic" || name === "action" || name === "formAction");
            if (!actionOk) reasons.push(`passes a function to \`${name}\``);
          } else if (tagClass === "client-reference") {
            const verdict = checkSerializable(checker, type, { primitivesOnly: ctx.isJs });
            if (!verdict.ok)
              reasons.push(`passes a non-serializable \`${name}\` to a Client Component`);
          }
        }
      }
    }

    const children = ts.isJsxSelfClosingElement(j.node) ? [] : j.node.children;
    for (const child of children) {
      if (!ts.isJsxExpression(child) || !child.expression) continue;
      const type = checker.getTypeAtLocation(child.expression);
      if (isCallableType(type))
        return skip("render-prop", "uses a function as a child (render prop)", locOf(ctx, child));
      if (tagClass === "client-reference") {
        const verdict = checkSerializable(checker, type, { primitivesOnly: ctx.isJs });
        if (!verdict.ok) reasons.push("passes non-serializable children to a Client Component");
      }
    }

    for (const id of refs) {
      const origin = originOf(id);
      if (origin.kind === "local" && origin.unit.client) reasons.push(`reads ${id.text}`);
      else if (origin.kind === "module" && clientModuleDecls.has(origin.decl))
        reasons.push(`uses ${id.text}`);
      else if (origin.kind === "import" && origin.usage.cls === "client-only" && !isTagRef(id))
        reasons.push(origin.usage.reason);
      else if (origin.kind === "browser-global") reasons.push(`uses ${origin.name}`);
      else if (origin.kind === "unknown" && !isTagRef(id))
        reasons.push(`uses ${id.text}, which can't be resolved`);
    }
    for (const marker of facts.scanMarkers(j.node, stop)) {
      if (marker.kind === "nondeterministic") reasons.push(`calls ${marker.detail}`);
    }
    if (reasons.length > 0) anchors.push({ j, reasons, refs });
  }

  // Non-JSX parts of the returned expressions (e.g. `cond ? <A/> : <B/>`) run on the server.
  for (const root of renderRoots) {
    if (isJsxElementLike(root)) continue; // an element is covered by its own anchor rules
    let problem: ts.Identifier | undefined;
    forEachValueRef(
      root,
      (id) => {
        if (problem) return;
        const origin = originOf(id);
        if ((origin.kind === "local" && origin.unit.client) || origin.kind === "browser-global")
          problem = id;
      },
      (n) => isJsxElementLike(n),
    );
    if (problem) {
      return skip(
        "state-spans-component",
        `the returned expression itself reads client-only \`${problem.text}\``,
        locOf(ctx, problem),
      );
    }
  }

  // ---- grouping -------------------------------------------------------------------------------------
  const closureOf = (refs: Iterable<ts.Identifier>): Set<Unit> => {
    const out = new Set<Unit>();
    const stack: Unit[] = [];
    for (const id of refs) {
      const origin = originOf(id);
      if (origin.kind === "local" && !out.has(origin.unit)) {
        out.add(origin.unit);
        stack.push(origin.unit);
      }
    }
    while (stack.length > 0) {
      const unit = stack.pop() as Unit;
      for (const dep of unit.localDeps) {
        if (!out.has(dep)) {
          out.add(dep);
          stack.push(dep);
        }
      }
    }
    return out;
  };

  const clientUnits = units.filter((u) => u.client);
  const totalJsx = jnodes.length;
  /** A client statement (typically an effect) that no island would carry, and why. */
  const unconnected = (unit: Unit, why: string) =>
    skip(
      "unsupported-pattern",
      `client-only code at line ${locOf(ctx, unit.node).line} isn't connected to any rendered element, and ${why}; moving it would change when it runs`,
      locOf(ctx, unit.node),
    );

  if (anchors.length === 0 && clientUnits.length === 0) {
    if (clientModuleDecls.size === 0) {
      return skip(
        "no-islands",
        `${component.name} uses no client-only features; removing "use client" may be enough (set removeUnusedDirectives to let the tool remove it)`,
      );
    }
    return skip(
      "unsupported-pattern",
      "client-only helpers aren't connected to any rendered element",
    );
  }

  /**
   * Where an island that only runs effects can go: the last child of the one element the component
   * returns. A component's effects run after its children's, and the last child's after its
   * siblings', so the effect keeps its place relative to everything the component renders. With
   * several returns it would have to be in every branch; a component element (`<Layout>`) would
   * get a different `children`; some elements can't hold children at all.
   */
  const effectsHost = (): JNode | string => {
    const [only, ...more] = renderRoots;
    if (more.length > 0) return "the component has more than one return";
    const host = only ? jnodeOf.get(only) : undefined;
    if (!host || !only) return "the component doesn't return a single element";
    if (ts.isJsxSelfClosingElement(host.node))
      return `the returned <${tagNameText(sf, host.node)} /> has no children to add to`;
    if (ts.isJsxElement(host.node)) {
      const opening = host.node.openingElement;
      const tag = tagNameText(sf, host.node);
      if (!isIntrinsicTagName(opening.tagName))
        return `the returned element is the component <${tag}>, whose children would change`;
      if (NO_EXTRA_CHILD_TAGS.has(tag)) return `the returned <${tag}> can't hold another child`;
      const innerHtml = opening.attributes.properties.some(
        (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "dangerouslySetInnerHTML",
      );
      if (innerHtml) return `the returned <${tag}> sets dangerouslySetInnerHTML`;
    }
    return host;
  };

  const trace = options.trace;
  const note = (step: string) => {
    if (trace && !trace.steps.includes(step)) trace.steps.push(step);
  };
  /** `<button> (line 12)` */
  const el = (j: JNode) => `<${tagNameText(sf, j.node)}> (line ${locOf(ctx, j.node).line})`;
  /** `` `open`, `setOpen` (line 5) `` or `useEffect() at line 7` */
  const unitDesc = (u: Unit): string => {
    const line = locOf(ctx, u.node).line;
    const names = [...u.declares].map((s) => `\`${s.getName()}\``);
    if (names.length > 0) return `${names.join(", ")} (line ${line})`;
    const hook = u.markers.find((m) => m.kind === "hook");
    return `${hook ? hook.detail : "the statement"} at line ${line}`;
  };
  for (const anchor of anchors) {
    trace?.anchors.push({
      element: `<${tagNameText(sf, anchor.j.node)}>`,
      line: locOf(ctx, anchor.j.node).line,
      reasons: [...new Set(anchor.reasons)],
    });
  }

  const uf = new UnionFind();
  const unitOwner = new Map<Unit, number>();
  anchors.forEach((anchor, i) => {
    for (const unit of closureOf(anchor.refs)) {
      if (!unit.client) continue;
      const owner = unitOwner.get(unit);
      if (owner === undefined) unitOwner.set(unit, i);
      else {
        const other = anchors[owner];
        if (other && uf.find(owner) !== uf.find(i))
          note(`${el(other.j)} and ${el(anchor.j)} share ${unitDesc(unit)}, so they're one island`);
        uf.union(owner, i);
      }
    }
  });

  /**
   * `extra`: client statements no element reads directly (effects...) attached to this island.
   * `effects`: the island renders nothing and only runs `extra` (see effectsHost).
   */
  type Group = { anchors: Anchor[]; root: JNode; extra: Set<Unit>; effects?: boolean };
  const groupsByRoot = new Map<number, Anchor[]>();
  anchors.forEach((anchor, i) => {
    const key = uf.find(i);
    const list = groupsByRoot.get(key) ?? [];
    list.push(anchor);
    groupsByRoot.set(key, list);
  });

  /**
   * Applies the loop rule. An island inside a `.map` callback renders once per item, so its root is
   * the mapped element. That is only safe when the island carries no component-level hooks:
   * moving `useState` into a per-item island would give every item its own copy of the state.
   * In that case the root climbs out to the element that contains the `.map`.
   */
  const mappedRoot = (root: JNode, perItemSafe: boolean): Outcome<JNode> => {
    let current: JNode | undefined = root;
    while (current) {
      const opaque = current.fnBetween.find((f) => !mapCallOf(f));
      if (opaque) {
        return skip(
          "render-prop",
          "an interactive element sits inside a callback other than .map()",
          locOf(ctx, current.node),
        );
      }
      if (current.fnBetween.some((f) => mapCallOf(f))) {
        if (perItemSafe) return ok(current);
        const container: JNode | undefined = current.parent;
        if (!container) {
          return skip(
            "state-spans-component",
            "state shared by every list item is used by the list itself, which is the returned element",
            locOf(ctx, current.node),
          );
        }
        note(
          `${el(current)} is rendered by .map() and the island uses component state, so the island is ${el(container)} around the list instead of one per item`,
        );
        root = container;
      }
      current = current.parent;
    }
    return ok(root);
  };

  // Hooks that only read shared context return the same value in every list item, so a per-item
  // island may call them; any other hook (state, refs, effects, custom hooks) must not be duplicated.
  const sharedContextHooks = new Set([
    ...REACT_SHARED_CONTEXT_HOOKS,
    ...ctx.framework.sharedContextHooks,
  ]);
  const hasComponentHooks = (groupAnchors: Anchor[]): boolean =>
    [...closureOf(groupAnchors.flatMap((a) => a.refs))].some((u) =>
      u.markers.some(
        (m) => m.kind === "hook" && !sharedContextHooks.has(m.detail.replace(/\(\)$/, "")),
      ),
    );

  let groups: Group[] = [];
  for (const groupAnchors of groupsByRoot.values()) {
    const lca = lowestCommonAncestor(groupAnchors.map((a) => a.j));
    if (!lca) {
      return skip(
        "state-spans-component",
        "the same client state is used in different returned trees",
        locOf(ctx, groupAnchors[0]?.j.node ?? fn),
      );
    }
    const mapped = mappedRoot(lca, !hasComponentHooks(groupAnchors));
    if (!mapped.ok) return mapped;
    if (groupAnchors.length > 1)
      note(
        `the island is ${el(mapped.value)}, the closest element around ${groupAnchors.map((a) => el(a.j)).join(", ")}`,
      );
    groups.push({ anchors: groupAnchors, root: mapped.value, extra: new Set() });
  }

  // Merge nested / overlapping islands and apply the escape check until stable.
  const unitClosure = (start: Iterable<Unit>): Set<Unit> => {
    const out = new Set<Unit>();
    const stack = [...start];
    while (stack.length > 0) {
      const unit = stack.pop() as Unit;
      if (out.has(unit)) continue;
      out.add(unit);
      stack.push(...unit.localDeps);
    }
    return out;
  };
  const unitHasOwnHooks = (u: Unit) =>
    u.markers.some(
      (m) => m.kind === "hook" && !sharedContextHooks.has(m.detail.replace(/\(\)$/, "")),
    );
  const groupHasHooks = (g: Group): boolean =>
    hasComponentHooks(g.anchors) || [...unitClosure(g.extra)].some(unitHasOwnHooks);
  const unitsOfGroup = (group: Group): Set<Unit> => {
    if (group.effects) return unitClosure(group.extra);
    const refs: ts.Identifier[] = [];
    forEachValueRef(group.root.node, (id) => refs.push(id));
    const units = closureOf(refs);
    for (const unit of unitClosure(group.extra)) units.add(unit);
    return units;
  };
  /**
   * Client statements that no element reads directly (typically `useEffect` syncing some state)
   * belong to the island that owns the state they use. Returns true if something changed.
   */
  const attachUnreadClientUnits = (): Outcome<boolean> => {
    let changed = false;
    for (const unit of units) {
      if (!unit.client || unit.kind === "early-return") continue;
      const owned = groups.map((g) => unitsOfGroup(g));
      if (owned.some((set) => set.has(unit))) continue;
      const deps = unitClosure(unit.localDeps);
      const owners = groups.filter((_, i) => [...deps].some((d) => d.client && owned[i]?.has(d)));
      const [first, ...rest] = owners;
      if (!first) continue; // uses no island's state: reported as unconnected later
      if (rest.length > 0) {
        const lca = lowestCommonAncestor(owners.map((g) => g.root));
        if (!lca)
          return skip(
            "state-spans-component",
            "client state is shared across returned trees",
            locOf(ctx, unit.node),
          );
        const merged = [...owners.flatMap((g) => g.anchors)];
        const mapped = mappedRoot(lca, !owners.some(groupHasHooks));
        if (!mapped.ok) return mapped;
        note(
          `${unitDesc(unit)} uses the state of the islands ${owners.map((g) => el(g.root)).join(", ")}, so they merge at ${el(mapped.value)}`,
        );
        first.anchors = merged;
        first.root = mapped.value;
        for (const other of rest) other.extra.forEach((u) => first.extra.add(u));
        groups = groups.filter((g) => !rest.includes(g));
      }
      first.extra.add(unit);
      note(
        `${unitDesc(unit)} isn't read by any element but uses the state of the island ${el(first.root)}, so it moves with it`,
      );
      if (unitHasOwnHooks(unit)) {
        // An effect must run once, not once per list item: keep the island out of any .map.
        const hoisted = mappedRoot(first.root, false);
        if (!hoisted.ok) return hoisted;
        first.root = hoisted.value;
      }
      changed = true;
    }
    return ok(changed);
  };

  for (let iteration = 0; iteration < 100; iteration++) {
    const attached = attachUnreadClientUnits();
    if (!attached.ok) return attached;
    let changed = attached.value;
    outer: for (const a of groups) {
      for (const b of groups) {
        if (a === b) continue;
        if (isAncestorOrSelf(a.root, b.root)) {
          note(`${el(b.root)} is inside the island ${el(a.root)}, so they're one island`);
          a.anchors.push(...b.anchors);
          b.extra.forEach((u) => a.extra.add(u));
          groups = groups.filter((g) => g !== b);
          changed = true;
          break outer;
        }
      }
    }
    if (changed) continue;
    // Client units shared between two islands -> merge at their LCA.
    const owner = new Map<Unit, Group>();
    for (const group of groups) {
      for (const unit of unitsOfGroup(group)) {
        if (!unit.client) continue;
        const other = owner.get(unit);
        if (other && other !== group) {
          const lca = lowestCommonAncestor([other.root, group.root]);
          if (!lca)
            return skip(
              "state-spans-component",
              "client state is shared across returned trees",
              locOf(ctx, unit.node),
            );
          const mapped = mappedRoot(lca, !(groupHasHooks(other) || groupHasHooks(group)));
          if (!mapped.ok) return mapped;
          note(
            `the islands ${el(other.root)} and ${el(group.root)} both use ${unitDesc(unit)}, so they merge at ${el(mapped.value)}`,
          );
          other.anchors.push(...group.anchors);
          group.extra.forEach((u) => other.extra.add(u));
          other.root = mapped.value;
          groups = groups.filter((g) => g !== group);
          changed = true;
          break;
        }
        owner.set(unit, group);
      }
      if (changed) break;
    }
    if (changed) continue;
    // Escape check: every read of an island's client bindings must be inside that island.
    for (const group of groups) {
      const islandUnits = unitsOfGroup(group);
      const clientDeclared = new Set<ts.Symbol>();
      for (const unit of islandUnits)
        if (unit.client) unit.declares.forEach((s) => clientDeclared.add(s));
      let escape: { node: ts.Identifier; j: JNode | undefined } | undefined;
      const check = (scope: ts.Node) =>
        forEachValueRef(scope, (id) => {
          if (escape) return;
          const symbol = symbolOfRef(checker, id);
          if (!symbol || !clientDeclared.has(symbol)) return;
          if (containsRange(group.root.node, id)) return;
          escape = { node: id, j: enclosingJNode(id, jnodeOf) };
        });
      for (const root of renderRoots) check(root);
      for (const unit of units) if (!islandUnits.has(unit)) unitNodes(unit).forEach(check);
      if (escape) {
        if (!escape.j) {
          return skip(
            "state-spans-component",
            `client-only \`${escape.node.text}\` is read outside the interactive part`,
            locOf(ctx, escape.node),
          );
        }
        const lca = lowestCommonAncestor([group.root, escape.j]);
        if (!lca)
          return skip(
            "state-spans-component",
            `client-only \`${escape.node.text}\` is read in another returned tree`,
            locOf(ctx, escape.node),
          );
        const mapped = mappedRoot(lca, !groupHasHooks(group));
        if (!mapped.ok) return mapped;
        note(
          `\`${escape.node.text}\` is read at line ${locOf(ctx, escape.node).line}, outside the island ${el(group.root)}, so the island grows to ${el(mapped.value)}`,
        );
        group.root = mapped.value;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  for (const group of groups) {
    if (!group.root.parent) {
      const single = group.anchors.length === 1 && group.anchors[0]?.j === group.root;
      if (single) {
        return skip(
          "fully-interactive",
          `the root <${tagNameText(sf, group.root.node)}> itself is interactive (${group.anchors[0]?.reasons[0] ?? "client-only"}), so nothing would stay on the server`,
          locOf(ctx, group.root.node),
        );
      }
      return skip(
        "state-spans-component",
        `client-only code is used across the whole returned tree (${describeAnchors(sf, group.anchors)})`,
        locOf(ctx, group.root.node),
      );
    }
  }

  // Every client statement must belong to exactly one island. Ones that no element uses and no
  // island owns move into an island that only runs them.
  const assigned = new Map<Unit, Group>();
  for (const group of groups)
    for (const unit of unitsOfGroup(group)) if (unit.client) assigned.set(unit, group);
  const orphans = clientUnits.filter((u) => u.kind !== "early-return" && !assigned.has(u));
  const [firstOrphan] = orphans;
  if (firstOrphan) {
    const host = effectsHost();
    if (typeof host === "string") return unconnected(firstOrphan, host);
    // The effects island renders after every other island, so its effects run after theirs. That
    // was the order only if no island's effect was declared after the statements that move.
    const firstIndex = Math.min(...orphans.map((u) => u.index));
    for (const group of groups) {
      for (const unit of unitsOfGroup(group)) {
        if (unit.index < firstIndex) continue;
        const effect = unit.markers.find(
          (m) =>
            m.kind === "hook" &&
            !NO_EFFECT_HOOKS.has(m.detail.replace(/\(\)$/, "")) &&
            !sharedContextHooks.has(m.detail.replace(/\(\)$/, "")),
        );
        if (effect)
          return unconnected(
            firstOrphan,
            `${effect.detail} at line ${locOf(ctx, effect.node).line} (in the island ${el(group.root)}) is declared after it, so its effects would run first`,
          );
      }
    }
    note(
      `${orphans.map(unitDesc).join(", ")} ${orphans.length === 1 ? "isn't" : "aren't"} used by any element or island, so ${orphans.length === 1 ? "it moves" : "they move"} to an island that renders nothing, added as the last child of ${el(host)}`,
    );
    groups.push({ anchors: [], root: host, extra: new Set(orphans), effects: true });
  }

  // ---- build island plans: statements, props, imports ----------------------------------------------
  /**
   * A body `const` whose value doesn't depend on props or on anything computed at render time
   * (`const perPage = 6`, an array of literals). The island declares it too instead of taking it
   * as a prop, so the value isn't serialized and hook dependency lists stay as they were.
   */
  const constantUnits = new Map<Unit, boolean>();
  const isConstantUnit = (unit: Unit): boolean => {
    const known = constantUnits.get(unit);
    if (known !== undefined) return known;
    constantUnits.set(unit, false);
    if (unit.kind !== "var" || unit.client || unit.extra) return false;
    let constant = true;
    const visit = (n: ts.Node): void => {
      if (!constant || isTypeSyntax(n)) return;
      if (
        ts.isCallExpression(n) ||
        ts.isNewExpression(n) ||
        ts.isTaggedTemplateExpression(n) ||
        ts.isFunctionLike(n) ||
        ts.isClassExpression(n) ||
        ts.isAwaitExpression(n) ||
        ts.isYieldExpression(n) ||
        ts.isDeleteExpression(n) ||
        ts.isPostfixUnaryExpression(n) ||
        (ts.isPrefixUnaryExpression(n) &&
          (n.operator === ts.SyntaxKind.PlusPlusToken ||
            n.operator === ts.SyntaxKind.MinusMinusToken)) ||
        (ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        isJsxElementLike(n)
      ) {
        constant = false;
        return;
      }
      ts.forEachChild(n, visit);
    };
    for (const decl of (unit.node as ts.VariableStatement).declarationList.declarations) {
      if (decl.initializer) visit(decl.initializer);
    }
    if (constant) {
      forEachValueRef(unit.node, (id) => {
        if (!constant) return;
        const origin = originOf(id);
        if (origin.kind === "local") constant = isConstantUnit(origin.unit);
        else if (origin.kind === "import") constant = origin.usage.cls !== "server-only";
        else constant = origin.kind === "module" || origin.kind === "global";
      });
    }
    constantUnits.set(unit, constant);
    return constant;
  };

  // In source order; the effects island goes last, where it's rendered.
  const groupPos = (g: Group) => (g.effects ? g.root.node.getEnd() : g.root.node.getStart(sf));
  groups.sort((a, b) => groupPos(a) - groupPos(b));
  const islands: IslandPlan[] = [];
  const copiedUnits = new Set<Unit>();

  // ---- donut slots: static subtrees inside an island stay on the server ---------------------------
  const anchorNodes = new Set(anchors.map((a) => a.j));
  const subtreeOf = (j: JNode): JNode[] => jnodes.filter((other) => isAncestorOrSelf(j, other));
  const isStaticSubtree = (j: JNode): boolean => {
    if (subtreeOf(j).some((n) => anchorNodes.has(n))) return false;
    if (facts.scanMarkers(j.node).length > 0) return false;
    let clientRead = false;
    forEachValueRef(j.node, (id) => {
      if (clientRead) return;
      const origin = originOf(id);
      if (
        (origin.kind === "local" && origin.unit.client) ||
        (origin.kind === "module" && clientModuleDecls.has(origin.decl)) ||
        (origin.kind === "import" &&
          origin.usage.cls !== "neutral" &&
          !(origin.usage.cls === "client-reference" && isTagRef(id))) ||
        origin.kind === "browser-global" ||
        origin.kind === "unknown" ||
        (origin.kind === "component" && !isTagRef(id))
      ) {
        clientRead = true;
      }
    });
    return !clientRead;
  };
  /**
   * Renders a component held in a variable (`<LinkIcon />` with `const LinkIcon = link.icon`). A
   * function can't cross the boundary as a prop, but the rendered element can, as a slot.
   */
  const rendersComponentValue = (j: JNode): boolean => {
    let found = false;
    forEachValueRef(j.node, (id) => {
      if (found || !isTagRef(id)) return;
      const kind = originOf(id).kind;
      if (kind === "param" || kind === "inner" || kind === "local") found = true;
    });
    return found;
  };
  const isNonTrivial = (j: JNode): boolean => {
    if (subtreeOf(j).length > 1 || rendersComponentValue(j)) return true;
    let importedCall = false;
    const visit = (n: ts.Node): void => {
      if (importedCall) return;
      if (ts.isCallExpression(n)) {
        let callee: ts.Expression = n.expression;
        while (ts.isPropertyAccessExpression(callee)) callee = callee.expression;
        if (ts.isIdentifier(callee) && originOf(callee).kind === "import") importedCall = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(j.node);
    return importedCall;
  };
  /** Maximal static, non-trivial subtrees reachable from the island root through direct JSX children. */
  const findSlots = (root: JNode): JNode[] => {
    const found: JNode[] = [];
    const visit = (j: JNode): void => {
      for (const child of j.children) {
        const direct = child.fnBetween.length === 0 && child.node.parent === j.node;
        if (!direct) continue;
        if (isStaticSubtree(child)) {
          if (isNonTrivial(child)) found.push(child);
          continue;
        }
        visit(child);
      }
    };
    visit(root);
    return found;
  };

  for (const group of groups) {
    const rootNode = group.root.node;
    const rootTag = group.effects ? "effects" : tagNameText(sf, rootNode);
    const islandUnits = new Set<Unit>([...unitsOfGroup(group)].filter((u) => u.client));
    const props = new Map<string, PropInfo>();
    const valueImports = new Set<ImportBinding>();
    const moduleDecls = new Set<ModuleDecl>();
    let keyAttr: ts.JsxAttribute | undefined;

    if (
      !group.effects &&
      !ts.isJsxFragment(rootNode) &&
      group.root.fnBetween.some((f) => mapCallOf(f))
    ) {
      const attrs = ts.isJsxElement(rootNode)
        ? rootNode.openingElement.attributes
        : rootNode.attributes;
      keyAttr = attrs.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === "key",
      );
    }

    const slotNodes = group.effects ? [] : findSlots(group.root);
    /** The JSX the island renders (none for an effects island). */
    const rendered: ts.Node[] = group.effects ? [] : [rootNode];
    const inSlot = (node: ts.Node): boolean =>
      slotNodes.some((slot) => containsRange(slot.node, node));
    const inIsland = (node: ts.Node): boolean =>
      (!group.effects &&
        containsRange(rootNode, node) &&
        !(keyAttr && containsRange(keyAttr, node)) &&
        !inSlot(node)) ||
      [...islandUnits].some((u) => unitNodes(u).some((n) => containsRange(n, node)));

    const pending: ts.Node[] = [...rendered, ...[...islandUnits].flatMap(unitNodes)];
    const visitedNodes = new Set<ts.Node>();
    const moduleLevelScopes = new Set<ts.Node>();
    const addProp = (id: ts.Identifier, symbol: ts.Symbol): Skip | undefined => {
      const name = symbol.getName();
      const existing = props.get(name);
      if (existing) {
        if (existing.symbol !== symbol) {
          return {
            code: "unsupported-pattern",
            message: `two different values named \`${name}\` would cross the boundary`,
            location: locOf(ctx, id),
          };
        }
        if (containsRange(rootNode, id) && !containsRange(rootNode, existing.refNode))
          existing.refNode = id;
        return undefined;
      }
      if (name === "key" || name === "ref") {
        return {
          code: "unsupported-pattern",
          message: `a value named \`${name}\` can't be passed as a prop`,
          location: locOf(ctx, id),
        };
      }
      props.set(name, { name, symbol, type: checker.getTypeAtLocation(id), refNode: id });
      return undefined;
    };

    while (pending.length > 0) {
      const scope = pending.pop() as ts.Node;
      if (visitedNodes.has(scope)) continue;
      visitedNodes.add(scope);
      let failure: Skip | undefined;
      forEachValueRef(scope, (id) => {
        if (failure) return;
        if (keyAttr && containsRange(keyAttr, id)) return;
        if (inSlot(id)) return; // rendered on the server and passed in as JSX
        const origin = originOf(id);
        switch (origin.kind) {
          case "param":
            failure = addProp(id, origin.symbol);
            return;
          case "local": {
            const unit = origin.unit;
            if (islandUnits.has(unit)) return;
            if (unit.client) {
              failure = {
                code: "state-spans-component",
                message: `client-only \`${id.text}\` is shared between islands`,
                location: locOf(ctx, id),
              };
              return;
            }
            const type = checker.getTypeAtLocation(id);
            const needsCopy =
              unit.kind === "function" ||
              isCallableType(type) ||
              !checkSerializable(checker, type, { primitivesOnly: ctx.isJs }).ok ||
              isConstantUnit(unit);
            if (needsCopy) {
              islandUnits.add(unit);
              copiedUnits.add(unit);
              pending.push(...unitNodes(unit));
            } else {
              failure = addProp(id, origin.symbol);
            }
            return;
          }
          case "inner":
            if (inIsland(origin.declaration)) return;
            if (
              [...moduleLevelScopes].some((scopeNode) =>
                containsRange(scopeNode, origin.declaration),
              )
            )
              return;
            failure = addProp(id, origin.symbol);
            return;
          case "module": {
            const decl = origin.decl;
            if (moduleDecls.has(decl)) return;
            // Module-level code already ran in the client bundle before the split, so the island
            // file gets its own copy (constants included) rather than a prop: the value and its
            // identity in hook dependency lists stay as they were.
            moduleDecls.add(decl);
            moduleLevelScopes.add(decl.statement);
            pending.push(decl.statement);
            return;
          }
          case "import":
            if (origin.usage.cls === "server-only") {
              failure = {
                code: "unsupported-pattern",
                message: `${id.text} (${origin.binding.specifier}) is server-only but the interactive part uses it`,
                location: locOf(ctx, id),
              };
              return;
            }
            valueImports.add(origin.binding);
            return;
          case "component": {
            const target = origin.component;
            if (target === component) {
              failure = {
                code: "unsupported-pattern",
                message: "an island would reference the component itself",
                location: locOf(ctx, id),
              };
              return;
            }
            if (!isTagRef(id)) {
              failure = {
                code: "unsupported-pattern",
                message: `an island uses the component ${id.text} as a value`,
                location: locOf(ctx, id),
              };
              return;
            }
            if (options.wholesale?.has(target)) return; // lives in the island file already
            // A server-safe component rendered inside an island: copy it into the island file.
            const decl = shape.componentDecls.get(target);
            if (!decl || moduleDecls.has(decl)) return;
            moduleDecls.add(decl);
            moduleLevelScopes.add(decl.statement);
            pending.push(decl.statement);
            return;
          }
          case "browser-global":
          case "global":
            return;
          case "unknown":
            failure = {
              code: "unsupported-pattern",
              message: `can't resolve \`${id.text}\``,
              location: locOf(ctx, id),
            };
            return;
        }
      });
      if (failure) return { ok: false, skip: failure };
    }

    /** References to a prop inside the island (not in its `key` or in server-rendered slots). */
    const islandRefs = (prop: PropInfo): ts.Identifier[] => {
      const refs: ts.Identifier[] = [];
      for (const scope of [...rendered, ...[...islandUnits].flatMap(unitNodes)]) {
        forEachValueRef(scope, (id) => {
          if ((keyAttr && containsRange(keyAttr, id)) || inSlot(id)) return;
          if (symbolOfRef(checker, id) === prop.symbol) refs.push(id);
        });
      }
      return refs;
    };
    const printType = (t: ts.Type) =>
      checker.typeToString(
        t,
        rootNode,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
    for (const prop of props.values()) {
      if (serverActionParams.has(prop.symbol)) continue; // a Server Action reference crosses as-is
      const verdict = checkSerializable(checker, prop.type, { primitivesOnly: ctx.isJs });
      if (verdict.ok) {
        const picked = ctx.isJs
          ? undefined
          : pickReadFields(checker, prop.name, prop.type, islandRefs(prop), printType);
        if (picked) prop.picked = picked;
        continue;
      }
      // The island may read only serializable fields of an object that also holds functions
      // (`link.href` and `link.name`, while `link.icon` is rendered in a server slot).
      const pickedSerializable = ctx.isJs
        ? undefined
        : pickReadFields(
            checker,
            prop.name,
            prop.type,
            islandRefs(prop),
            printType,
            (t) => checkSerializable(checker, t).ok,
          );
      if (pickedSerializable) {
        prop.picked = pickedSerializable;
        continue;
      }
      if (!ctx.isJs && ctx.config.mongoose.autoSerialize && isMongooseLike(checker, prop.type)) {
        const picked = pickMongooseFields(checker, prop.name, islandRefs(prop), printType);
        if (picked.ok) {
          prop.picked = picked.value;
          continue;
        }
        return skip(
          "non-serializable-prop",
          `\`${prop.name}\` holds Mongoose/ObjectId data and the island ${picked.reason}`,
          locOf(ctx, prop.refNode),
        );
      }
      const typeText = checker.typeToString(prop.type, rootNode, ts.TypeFormatFlags.NoTruncation);
      const usedInSpread = isSpreadInside(rootNode, prop.symbol, checker);
      if (ctx.isJs) {
        return skip(
          "untyped-boundary",
          `\`${prop.name}\` would cross the server/client boundary, but its type in this untyped file (\`${typeText}\`) can't be proven serializable`,
          locOf(ctx, prop.refNode),
        );
      }
      return skip(
        usedInSpread ? "spread-props" : "non-serializable-prop",
        `\`${prop.name}\` (type \`${typeText}\`) would be passed to a Client Component, but it ${verdict.reason}`,
        locOf(ctx, prop.refNode),
      );
    }

    if (keyAttr) {
      let clientKey: ts.Identifier | undefined;
      forEachValueRef(keyAttr, (id) => {
        const origin = originOf(id);
        if (origin.kind === "local" && origin.unit.client) clientKey = id;
      });
      if (clientKey)
        return skip(
          "unsupported-pattern",
          `the list key reads client-only \`${clientKey.text}\``,
          locOf(ctx, clientKey),
        );
    }

    const sortedUnits = [...islandUnits].sort((a, b) => a.index - b.index);
    const slots = slotNodes.map((j, i) => ({
      j,
      name: slotNodes.length === 1 && !props.has("children") ? "children" : `slot${i + 1}`,
    }));
    const label = group.effects ? "the effects island" : `the island ${el(group.root)}`;
    for (const slot of slots)
      note(
        `${el(slot.j)} inside ${label} is static, so it renders on the server and is passed in as \`${slot.name}\``,
      );
    const crossing = [...props.values()].map((p) =>
      p.picked
        ? `\`${p.name}={${p.picked.serverExpr}}\` (only the fields it reads)`
        : `\`${p.name}\``,
    );
    if (crossing.length > 0) note(`${label} receives ${crossing.join(", ")} from the server`);
    islands.push({
      name: "",
      root: group.root,
      rootTag,
      keyAttr,
      units: sortedUnits,
      props: [...props.values()].sort(
        (a, b) =>
          declarationPos(a.symbol) - declarationPos(b.symbol) || a.name.localeCompare(b.name),
      ),
      valueImports,
      moduleDecls,
      slots,
      line: locOf(ctx, group.effects ? (sortedUnits[0]?.node ?? rootNode) : rootNode).line,
      ...(group.effects ? { effects: true } : {}),
    });
  }

  // ---- which statements leave the server component ---------------------------------------------------
  const removedUnits = new Set<Unit>(clientUnits.filter((u) => u.kind !== "early-return"));
  // Copied (non-client) statements stay only if server code still reads them.
  const islandRanges = islands.filter((i) => !i.effects).map((i) => i.root.node);
  const slotRanges = islands.flatMap((i) => i.slots.map((slot) => slot.j.node));
  const inAnySlot = (node: ts.Node): boolean => slotRanges.some((r) => containsRange(r, node));
  const serverReads = (unit: Unit): boolean => {
    let read = false;
    const scan = (scope: ts.Node) =>
      forEachValueRef(scope, (id) => {
        if (read) return;
        if (islandRanges.some((r) => containsRange(r, id)) && !inAnySlot(id)) return;
        const symbol = symbolOfRef(checker, id);
        if (symbol && unit.declares.has(symbol)) read = true;
      });
    for (const root of renderRoots) scan(root);
    for (const cond of earlyReturnConditions) scan(cond);
    for (const other of units)
      if (other !== unit && !removedUnits.has(other)) unitNodes(other).forEach(scan);
    // Props are evaluated on the server.
    for (const island of islands)
      for (const prop of island.props) if (unit.declares.has(prop.symbol)) read = true;
    return read;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of copiedUnits) {
      if (removedUnits.has(unit)) continue;
      if (!serverReads(unit)) {
        removedUnits.add(unit);
        changed = true;
      }
    }
  }

  // Module declarations: client-only ones may never stay in the server file.
  const movedModuleDecls = new Set<ModuleDecl>();
  for (const decl of clientModuleDecls) movedModuleDecls.add(decl);

  const staticCount = jnodes.filter(
    (j) =>
      !islands.some((i) => !i.effects && isAncestorOrSelf(i.root, j)) ||
      islands.some((i) => i.slots.some((slot) => isAncestorOrSelf(slot.j, j))),
  ).length;
  return ok({
    component,
    islands,
    removedUnits,
    movedModuleDecls,
    staticRatio: totalJsx === 0 ? 0 : staticCount / totalJsx,
    jsxTotal: totalJsx,
  });
}

/**
 * A `let` in a component body and the statements right after it that only assign it: `x = ...`
 * (any assignment operator), or `if`/`else` branches that do nothing else. Together they compute a
 * value that never changes afterwards, so the variable is used like a `const`. Returns why not
 * otherwise: `var`, several variables or a destructuring pattern, or an assignment anywhere else
 * (a later statement, a callback).
 */
function letGroup(
  checker: ts.TypeChecker,
  statement: ts.VariableStatement,
  following: readonly ts.Statement[],
  body: ts.Block,
): { symbol: ts.Symbol; extra: ts.Statement[] } | string {
  const sf = statement.getSourceFile();
  const list = statement.declarationList;
  if (!(list.flags & ts.NodeFlags.Let)) return "declares a `var` in the component body";
  const [decl, ...more] = list.declarations;
  if (!decl || more.length > 0 || !ts.isIdentifier(decl.name))
    return "declares a `let` other than a single variable in the component body";
  const name = decl.name;
  const symbol = checker.getSymbolAtLocation(name);
  if (!symbol) return "declares a `let` the type checker can't resolve";
  const isTarget = (e: ts.Expression) =>
    ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === symbol;
  const assignsOnly = (s: ts.Statement): boolean => {
    if (ts.isExpressionStatement(s)) {
      const e = stripParens(s.expression);
      return (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        e.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        isTarget(e.left)
      );
    }
    if (ts.isBlock(s)) return s.statements.length > 0 && s.statements.every(assignsOnly);
    if (ts.isIfStatement(s))
      return assignsOnly(s.thenStatement) && (!s.elseStatement || assignsOnly(s.elseStatement));
    return false;
  };
  const extra: ts.Statement[] = [];
  for (const s of following) {
    if (!assignsOnly(s)) break;
    extra.push(s);
  }
  // Any other write (a later statement, a handler, a nested function, a destructuring
  // assignment, a for-of) means it isn't a value.
  let elsewhere: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (elsewhere || extra.includes(n as ts.Statement)) return;
    if (ts.isIdentifier(n) && symbolOfRef(checker, n) === symbol && isWriteTarget(n)) {
      elsewhere = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  for (const s of body.statements) if (s !== statement) visit(s);
  if (elsewhere) {
    const line = sf.getLineAndCharacterOfPosition(elsewhere.getStart(sf)).line + 1;
    return `\`${name.text}\` is assigned at line ${line}; a \`let\` is supported when it's only assigned right after its declaration`;
  }
  return { symbol, extra };
}

/**
 * Whether an identifier is written: the target of an assignment (also inside a destructuring
 * pattern, a cast or parentheses), of `++`/`--`, or the variable of a `for...in`/`for...of`.
 */
function isWriteTarget(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    const passThrough =
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
      (ts.isShorthandPropertyAssignment(parent) && parent.name === node);
    if (passThrough) continue;
    if (ts.isBinaryExpression(parent))
      return (
        parent.left === node &&
        parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      return (
        parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken
      );
    return (
      (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === node
    );
  }
  return false;
}

function declarationPos(symbol: ts.Symbol): number {
  return symbol.declarations?.[0]?.getStart() ?? Number.MAX_SAFE_INTEGER;
}

function containsJsxNode(node: ts.Node): boolean {
  if (isJsxElementLike(node)) return true;
  return ts.forEachChild(node, (c) => (containsJsxNode(c) ? true : undefined)) ?? false;
}

function isTagRef(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  while (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
    node = node.parent;
  const parent = node.parent;
  return (
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
    parent.tagName === node
  );
}

function enclosingJNode(node: ts.Node, jnodeOf: Map<ts.Node, JNode>): JNode | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const j = jnodeOf.get(current);
    if (j) return j;
    current = current.parent;
  }
  return undefined;
}

function conditionalAncestor(node: ts.Node, stopAt: ts.Node): string | undefined {
  let child: ts.Node = node;
  let current: ts.Node | undefined = node.parent;
  while (current && current !== stopAt) {
    if (ts.isConditionalExpression(current) && child !== current.condition)
      return "inside a conditional expression";
    if (
      ts.isBinaryExpression(current) &&
      child === current.right &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) {
      return "inside a logical expression";
    }
    if (ts.isIfStatement(current) || ts.isSwitchStatement(current)) return "inside a condition";
    if (ts.isIterationStatement(current, false)) return "inside a loop";
    if (ts.isFunctionLike(current)) return "inside a nested function";
    child = current;
    current = current.parent;
  }
  return undefined;
}

function isSpreadInside(root: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isJsxSpreadAttribute(n) || ts.isSpreadAssignment(n) || ts.isSpreadElement(n)) &&
      ts.isIdentifier(n.expression)
    ) {
      if (checker.getSymbolAtLocation(n.expression) === symbol) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/** "<div>, <h2>: cn from @/lib/utils is client-only (...); <button>: has onClick" */
function describeAnchors(sf: ts.SourceFile, anchors: { j: JNode; reasons: string[] }[]): string {
  const tagsByReason = new Map<string, string[]>();
  for (const anchor of anchors) {
    const reason = anchor.reasons[0] ?? "client-only";
    const tags = tagsByReason.get(reason) ?? [];
    const tag = `<${tagNameText(sf, anchor.j.node)}>`;
    if (!tags.includes(tag)) tags.push(tag);
    tagsByReason.set(reason, tags);
  }
  const parts = [...tagsByReason].map(
    ([reason, tags]) =>
      `${tags.slice(0, 4).join(", ")}${tags.length > 4 ? ", ..." : ""}: ${reason}`,
  );
  return parts.slice(0, 3).join("; ") + (parts.length > 3 ? "; ..." : "");
}
