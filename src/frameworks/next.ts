import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ts } from "ts-morph";
import type { BindingClass, FrameworkAdapter, FrameworkModuleRule } from "../analysis/framework.js";

const perName = (classify: (name: string) => BindingClass): FrameworkModuleRule => ({
  kind: "per-name",
  classify,
});
const hooksClient = (name: string): BindingClass =>
  /^use[A-Z]/.test(name) ? "client-only" : "neutral";

/** next/navigation functions that work in Server Components (everything else there is a hook). */
const NAVIGATION_SERVER_SAFE = new Set([
  "redirect",
  "permanentRedirect",
  "notFound",
  "forbidden",
  "unauthorized",
  "RedirectType",
  "unstable_rethrow",
]);

export const nextAdapter: FrameworkAdapter = {
  name: "next",

  classifyModule(specifier) {
    if (specifier === "next/dynamic") return { kind: "dynamic-import" };
    if (specifier === "styled-jsx" || specifier.startsWith("styled-jsx/"))
      return { kind: "css-in-js" };
    // Client Components shipped by Next: rendering them from the server is the normal pattern.
    if (
      ["next/link", "next/image", "next/script", "next/form", "next/legacy/image"].includes(
        specifier,
      )
    ) {
      return perName((name) =>
        name === "default" || /^[A-Z]/.test(name) ? "client-reference" : "neutral",
      );
    }
    if (specifier === "next/navigation") {
      return perName((name) => (NAVIGATION_SERVER_SAFE.has(name) ? "neutral" : "client-only"));
    }
    if (specifier === "next/router" || specifier === "next/head" || specifier === "next/amp") {
      return perName(() => "client-only");
    }
    if (
      ["next/headers", "next/server", "next/cache", "next/after", "next/og"].includes(specifier)
    ) {
      return perName(() => "server-only");
    }
    if (specifier.startsWith("next/font/")) return perName(() => "neutral");
    if (specifier === "next" || specifier === "next/types") return perName(hooksClient);
    if (specifier.startsWith("next/")) return perName(() => "client-only");
    return undefined;
  },

  isClientVisibleEnv(name) {
    return name.startsWith("NEXT_PUBLIC_") || name === "NODE_ENV";
  },

  mustStayClientFiles: ["error", "global-error"],

  sharedContextHooks: [
    "usePathname",
    "useSearchParams",
    "useParams",
    "useRouter",
    "useSelectedLayoutSegment",
    "useSelectedLayoutSegments",
  ],
};

const NEXT_ROUTE_FILE_BASENAMES = ["page", "route"];
const DEFAULT_PAGE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

type PageExtensionsResult = { ok: true; extensions: string[] } | { ok: false; reason: string };

/**
 * Reads `pageExtensions` from next.config.* without executing it. If the config mentions
 * pageExtensions in a form we can't read statically, we report that instead of guessing.
 */
export function readPageExtensions(root: string): PageExtensionsResult {
  const candidates = [
    "next.config.ts",
    "next.config.mjs",
    "next.config.js",
    "next.config.cjs",
    "next.config.mts",
  ];
  const file = candidates.map((c) => path.join(root, c)).find((f) => existsSync(f));
  if (!file) return { ok: true, extensions: DEFAULT_PAGE_EXTENSIONS };
  const text = readFileSync(file, "utf8");
  if (!text.includes("pageExtensions")) return { ok: true, extensions: DEFAULT_PAGE_EXTENSIONS };

  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found: string[] | undefined;
  let unreadable = false;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) && node.name.getText(sf) === "pageExtensions") ||
      (ts.isShorthandPropertyAssignment(node) && node.name.text === "pageExtensions")
    ) {
      const init = ts.isPropertyAssignment(node) ? node.initializer : undefined;
      if (
        init &&
        ts.isArrayLiteralExpression(init) &&
        init.elements.every(ts.isStringLiteralLike)
      ) {
        found = init.elements.map((e) => (e as ts.StringLiteralLike).text);
      } else {
        unreadable = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (unreadable || !found) {
    return {
      ok: false,
      reason: `${path.basename(file)} sets pageExtensions in a way that can't be read statically`,
    };
  }
  return { ok: true, extensions: found };
}

/**
 * True if a generated file at `absPath` could be picked up as a route by Next.js: anything under a
 * `pages/` directory, or an app-router `page`/`route` file for one of the configured extensions.
 */
export function couldBecomeRoute(root: string, absPath: string, pageExtensions: string[]): boolean {
  const rel = path.relative(root, absPath).split(path.sep);
  if (rel[0] === "pages" || (rel[0] === "src" && rel[1] === "pages")) return true;
  const base = path.basename(absPath);
  return pageExtensions.some((ext) =>
    NEXT_ROUTE_FILE_BASENAMES.some((name) => base === `${name}.${ext}`),
  );
}
