import { ts } from "ts-morph";
import type { FrameworkAdapter } from "./framework.js";
import type { ImportBinding, ImportTable, ProjectModuleSafety, UsageClass } from "./importTable.js";
import { classifyImportUsage } from "./importTable.js";
import { HOOK_NAME_RE, calleeName, forEachValueRef, symbolOfRef } from "./refs.js";

/** Globals that only exist (or only make sense) in the browser. */
export const BROWSER_GLOBALS = new Set([
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

export type RefInfo =
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
        usage: classifyImportUsage(binding, member, asJsxTag, this.framework, this.projectSafety),
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
      const nondeterministic = nondeterministicCall(n);
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

export type EnvProblem = { node: ts.Node; message: string };

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
