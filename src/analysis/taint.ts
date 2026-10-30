import { ts } from "ts-morph";
import { clockReadingCall } from "./dateLibraries.js";
import type { FrameworkAdapter } from "./framework.js";
import type { ImportBinding, ImportTable, ProjectModuleSafety, UsageClass } from "./importTable.js";
import { classifyImportUsage } from "./importTable.js";
import { HOOK_NAME_RE, calleeName, forEachValueRef, symbolOfRef } from "./refs.js";
import type { CallTarget, SafetyRules } from "./rules.js";
import { describeCall } from "./rules.js";

/** Globals that only exist (or only make sense) in the browser. */
const BROWSER_GLOBALS = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "history",
  "matchMedia",
  "IntersectionObserver",
  "ResizeObserver",
  "MutationObserver",
  "PerformanceObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "alert",
  "confirm",
  "prompt",
  "self",
  "screen",
  "innerWidth",
  "innerHeight",
  "outerWidth",
  "outerHeight",
  "scrollX",
  "scrollY",
  "pageXOffset",
  "pageYOffset",
  "devicePixelRatio",
  "visualViewport",
  "getComputedStyle",
  "getSelection",
  "customElements",
  "indexedDB",
  "caches",
  "Notification",
  "FileReader",
  "Image",
  "Audio",
  "Worker",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "DOMParser",
  "HTMLElement",
  "Element",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "scrollTo",
  "scrollBy",
  "print",
  "open",
  "close",
  "postMessage",
  "frames",
  "parent",
  "top",
  "opener",
  "origin",
  "event",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
]);

export type MarkerKind = "hook" | "browser-global" | "client-import" | "nondeterministic";

export type Marker = {
  kind: MarkerKind;
  node: ts.Node;
  detail: string;
  special?: UsageClass["special"];
};

type RefInfo =
  | { kind: "import"; binding: ImportBinding; usage: UsageClass }
  | { kind: "browser-global"; name: string }
  | { kind: "global" }
  | { kind: "file"; symbol: ts.Symbol; declaration: ts.Declaration }
  | { kind: "unknown" };

function isAmbientDeclaration(decl: ts.Declaration): boolean {
  return decl.getSourceFile().isDeclarationFile;
}

/** Per-file helper that classifies identifiers and finds client-only markers. */
export class FileFacts {
  constructor(
    readonly sf: ts.SourceFile,
    readonly checker: ts.TypeChecker,
    readonly imports: ImportTable,
    readonly framework: FrameworkAdapter,
    readonly projectSafety: ProjectModuleSafety,
    readonly serverSafeHooks: ReadonlySet<string>,
    readonly rules?: SafetyRules,
  ) {}

  classifyRef(id: ts.Identifier): RefInfo {
    const symbol = symbolOfRef(this.checker, id);
    if (!symbol)
      return BROWSER_GLOBALS.has(id.text)
        ? { kind: "browser-global", name: id.text }
        : { kind: "unknown" };
    const binding = this.imports.bySymbol.get(symbol);
    if (binding) {
      const parent = id.parent;
      const member =
        parent && ts.isPropertyAccessExpression(parent) && parent.expression === id
          ? parent.name.text
          : undefined;
      const asJsxTag =
        (parent &&
          (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
          parent.tagName === id) ||
        (parent !== undefined &&
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === id &&
          (ts.isJsxOpeningElement(parent.parent) || ts.isJsxSelfClosingElement(parent.parent)) &&
          parent.parent.tagName === parent);
      return {
        kind: "import",
        binding,
        usage: classifyImportUsage(
          binding,
          member,
          asJsxTag,
          this.framework,
          this.projectSafety,
          this.rules,
        ),
      };
    }
    const decl = symbol.valueDeclaration ?? symbol.declarations?.[0];
    // Intrinsic globals such as `undefined` and `globalThis` have no declarations.
    if (!decl) return { kind: "global" };
    if (decl.getSourceFile() === this.sf) return { kind: "file", symbol, declaration: decl };
    if (isAmbientDeclaration(decl)) {
      return BROWSER_GLOBALS.has(id.text) && !(symbol.flags & ts.SymbolFlags.Alias)
        ? { kind: "browser-global", name: id.text }
        : { kind: "global" };
    }
    return { kind: "unknown" };
  }

  isHookCall(call: ts.CallExpression): boolean {
    const name = calleeName(call);
    if (!name) return false;
    if (this.serverSafeHooks.has(name)) return false;
    if (HOOK_NAME_RE.test(name)) return true;
    if (name === "use") {
      const [arg] = call.arguments;
      if (!arg) return false;
      const type = this.checker.getTypeAtLocation(arg);
      // A Context has Provider/Consumer; use(promise) is fine on the server.
      return (
        type.getProperty("Provider") !== undefined || type.getProperty("Consumer") !== undefined
      );
    }
    return false;
  }

  /**
   * Client-only markers under `node`. `stop` prunes subtrees (nested JSX elements when scanning
   * one element's own attributes and children).
   */
  scanMarkers(node: ts.Node, stop?: (n: ts.Node) => boolean): Marker[] {
    const markers: Marker[] = [];
    const visit = (n: ts.Node): void => {
      if (n !== node && stop?.(n)) return;
      if (ts.isCallExpression(n) && this.isHookCall(n)) {
        markers.push({ kind: "hook", node: n, detail: `${calleeName(n) ?? "hook"}()` });
      }
      const nondeterministic =
        nondeterministicCall(n) ??
        clockReadingCall(this.checker, n) ??
        this.localeDependentCall(n) ??
        this.ruleDependentCall(n);
      if (nondeterministic)
        markers.push({ kind: "nondeterministic", node: n, detail: nondeterministic });
      ts.forEachChild(n, visit);
    };
    visit(node);
    forEachValueRef(
      node,
      (id) => {
        const info = this.classifyRef(id);
        if (info.kind === "browser-global")
          markers.push({ kind: "browser-global", node: id, detail: info.name });
        else if (info.kind === "import" && info.usage.cls === "client-only") {
          markers.push({
            kind: "client-import",
            node: id,
            detail: info.usage.reason,
            special: info.usage.special,
          });
        } else if (info.kind === "import" && info.usage.special) {
          markers.push({
            kind: "client-import",
            node: id,
            detail: info.usage.reason,
            special: info.usage.special,
          });
        }
      },
      stop,
    );
    return markers;
  }

  /** What a call calls, as `rules` entries name it (an imported export or a global path). */
  callTarget(call: ts.CallExpression | ts.NewExpression): CallTarget | undefined {
    const members: string[] = [];
    let head: ts.Expression = call.expression;
    while (ts.isPropertyAccessExpression(head)) {
      members.unshift(head.name.text);
      head = head.expression;
    }
    if (!ts.isIdentifier(head)) return undefined;
    const info = this.classifyRef(head);
    if (info.kind === "import") {
      const { binding } = info;
      if (binding.module.kind !== "external") return undefined;
      if (binding.imported === "*")
        return members.length === 1 && members[0]
          ? { specifier: binding.specifier, exportName: members[0] }
          : undefined;
      return members.length === 0
        ? { specifier: binding.specifier, exportName: binding.imported }
        : undefined;
    }
    if (info.kind === "global" || info.kind === "browser-global")
      return { global: [head.text, ...members].join(".") };
    return undefined;
  }

  /** A call `rules.browserDependentCalls` names. */
  private ruleDependentCall(n: ts.Node): string | undefined {
    if (!this.rules?.hasCallRules || (!ts.isCallExpression(n) && !ts.isNewExpression(n)))
      return undefined;
    const target = this.callTarget(n);
    return target && this.rules.browserDependent(target)
      ? `${describeCall(target)} (rules.browserDependentCalls)`
      : undefined;
  }

  /**
   * Formatting that depends on the runtime's locale or timezone, which differ between the server
   * and the user's browser: `toLocaleString()` and friends, `localeCompare()`, `Intl.*`. A call
   * that names its locale (and, for dates, its `timeZone`) gives the same result everywhere.
   */
  private localeDependentCall(n: ts.Node): string | undefined {
    if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return undefined;
    const callee = n.expression;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const method = callee.name.text;
    const args = n.arguments ?? [];
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "Intl") {
      const pinned = namesLocale(args[0]) && (method !== "DateTimeFormat" || setsTimeZone(args[1]));
      return pinned ? undefined : `Intl.${method}`;
    }
    if (!ts.isCallExpression(n)) return undefined;
    if (method === "localeCompare") return namesLocale(args[1]) ? undefined : `${method}()`;
    if (method === "toLocaleUpperCase" || method === "toLocaleLowerCase")
      return namesLocale(args[0]) ? undefined : `${method}()`;
    if (!/^toLocale(?:Date|Time)?String$/.test(method)) return undefined;
    const receiver = this.checker.getTypeAtLocation(callee.expression);
    const isNumber = (receiver.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0;
    const pinned = namesLocale(args[0]) && (isNumber || setsTimeZone(args[1]));
    return pinned ? undefined : `${method}()`;
  }
}

/** A locale given as a string literal (or a list of them), not left to the runtime default. */
function namesLocale(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  if (ts.isStringLiteralLike(arg)) return true;
  return (
    ts.isArrayLiteralExpression(arg) &&
    arg.elements.length > 0 &&
    arg.elements.every((e) => ts.isStringLiteralLike(e))
  );
}

/** An options object literal with an explicit `timeZone`. */
function setsTimeZone(arg: ts.Expression | undefined): boolean {
  return (
    arg !== undefined &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.some(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name.getText() === "timeZone",
    )
  );
}

/** Calls whose result differs between the server render and the browser render. */
function nondeterministicCall(n: ts.Node): string | undefined {
  if (
    ts.isNewExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "Date" &&
    (n.arguments?.length ?? 0) === 0
  ) {
    return "new Date()";
  }
  if (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression)
  ) {
    const object = n.expression.expression.text;
    const method = n.expression.name.text;
    if (
      (object === "Date" && method === "now") ||
      (object === "Math" && method === "random") ||
      (object === "performance" && method === "now") ||
      (object === "crypto" && (method === "randomUUID" || method === "getRandomValues"))
    ) {
      return `${object}.${method}()`;
    }
  }
  return undefined;
}

type EnvProblem = { node: ts.Node; message: string };

/**
 * Finds reads of environment values that differ between the server and the browser bundle:
 * `process.env.SECRET` is defined on the server but `undefined` in the browser.
 */
export function findEnvProblem(
  node: ts.Node,
  checker: ts.TypeChecker,
  framework: FrameworkAdapter,
): EnvProblem | undefined {
  let problem: EnvProblem | undefined;
  const visit = (n: ts.Node): void => {
    if (problem) return;
    if (ts.isIdentifier(n) && n.text === "process" && isGlobalProcess(n, checker)) {
      const parent = n.parent;
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === n &&
        parent.name.text === "env"
      ) {
        const outer = parent.parent;
        if (ts.isPropertyAccessExpression(outer) && outer.expression === parent) {
          const name = outer.name.text;
          if (!framework.isClientVisibleEnv(name)) {
            problem = {
              node: outer,
              message: `reads process.env.${name}, which is defined on the server but not in the browser bundle`,
            };
          }
          return;
        }
        if (
          ts.isElementAccessExpression(outer) &&
          outer.expression === parent &&
          ts.isStringLiteralLike(outer.argumentExpression)
        ) {
          const name = outer.argumentExpression.text;
          if (!framework.isClientVisibleEnv(name)) {
            problem = {
              node: outer,
              message: `reads process.env["${name}"], which is defined on the server but not in the browser bundle`,
            };
          }
          return;
        }
        problem = {
          node: parent,
          message:
            "reads process.env dynamically; its value differs between the server and the browser",
        };
        return;
      }
      if (!(ts.isTypeOfExpression(parent) || ts.isTypeQueryNode(parent))) {
        problem = {
          node: n,
          message: "reads `process`, which differs between the server and the browser",
        };
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return problem;
}

function isGlobalProcess(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  if (ts.isPropertyAccessExpression(id.parent) && id.parent.name === id) return false;
  const symbol = checker.getSymbolAtLocation(id);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return !decl || decl.getSourceFile().isDeclarationFile;
}
