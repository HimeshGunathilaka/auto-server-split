import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import {
  BUILTIN_CLIENT_ONLY_PACKAGES,
  BUILTIN_SERVER_SAFE_PACKAGES,
  CSS_IN_JS_PACKAGES,
  matchesPackageList,
  packageNameOf,
} from "../analysis/clientPackages.js";
import type { FrameworkAdapter } from "../analysis/framework.js";
import type { ExternalKind, ExternalModuleInfo } from "./moduleTypes.js";

const STYLESHEET_RE = /\.(css|scss|sass|less|styl|pcss)$/;
const CSS_MODULE_RE = /\.module\.(css|scss|sass|less|styl|pcss)$/;
const ASSET_RE = /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mp3|wav|woff2?|ttf|otf)$/;

type PackageJson = {
  name?: string;
  main?: string;
  module?: string;
  browser?: unknown;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export class PackageClassifier {
  private cache = new Map<string, ExternalModuleInfo>();

  constructor(
    private readonly framework: FrameworkAdapter,
    private readonly extraClientOnly: readonly string[],
    private readonly extraServerSafe: readonly string[],
  ) {}

  /** Classifies a non-relative specifier (or an unresolved relative one with an asset extension). */
  classify(specifier: string, fromFile: string): ExternalModuleInfo {
    const key = `${path.dirname(fromFile)}\0${specifier}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const info = {
      specifier,
      packageName: packageNameOf(specifier),
      ...this.compute(specifier, fromFile),
    };
    this.cache.set(key, info);
    return info;
  }

  private compute(specifier: string, fromFile: string): { kind: ExternalKind; detail?: string } {
    if (CSS_MODULE_RE.test(specifier)) return { kind: "css-module" };
    if (STYLESHEET_RE.test(specifier)) return { kind: "stylesheet" };
    if (specifier.endsWith(".json")) return { kind: "json" };
    if (ASSET_RE.test(specifier)) return { kind: "asset" };
    if (specifier.startsWith(".") || specifier.startsWith("/")) return { kind: "unresolved" };

    const name = packageNameOf(specifier);
    if (
      specifier.startsWith("node:") ||
      builtinModules.includes(name) ||
      builtinModules.includes(specifier)
    ) {
      return { kind: "builtin" };
    }
    if (name === "react") return { kind: "react" };
    if (name === "react-dom") return { kind: "react-dom" };
    if (specifier === "server-only") return { kind: "server-only-marker" };
    if (specifier === "client-only") return { kind: "client-only-marker" };
    if (this.framework.classifyModule(specifier)) return { kind: "framework" };
    if (matchesPackageList(specifier, CSS_IN_JS_PACKAGES)) return { kind: "css-in-js" };
    if (matchesPackageList(specifier, this.extraClientOnly))
      return { kind: "client-list", detail: "clientOnlyPackages config" };
    const serverSafe: { kind: ExternalKind; detail?: string } | undefined = matchesPackageList(
      specifier,
      this.extraServerSafe,
    )
      ? { kind: "server-safe-list", detail: "serverSafePackages config" }
      : matchesPackageList(specifier, BUILTIN_SERVER_SAFE_PACKAGES)
        ? { kind: "server-safe-list" }
        : undefined;
    if (!serverSafe && matchesPackageList(specifier, BUILTIN_CLIENT_ONLY_PACKAGES))
      return { kind: "client-list" };

    const pkgDir = findPackageDir(name, path.dirname(fromFile));
    if (!pkgDir)
      return serverSafe ?? { kind: "unresolved", detail: `package ${name} is not installed` };
    const pkg = readPackageJson(pkgDir);
    if (!pkg)
      return serverSafe ?? { kind: "unresolved", detail: `can't read ${name}/package.json` };

    // A "use client" entry point is a client reference even in a server-safe package.
    const entry = resolveEntry(pkgDir, pkg, specifier.slice(name.length));
    if (entry && startsWithUseClient(entry)) return { kind: "use-client-entry" };
    if (serverSafe) return serverSafe;

    const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
    if ("react" in deps || "react-dom" in deps || "next" in deps || "preact" in deps) {
      return {
        kind: "react-unknown",
        detail: `${name} depends on React and isn't known to be server-safe`,
      };
    }
    return { kind: "neutral" };
  }
}

function findPackageDir(name: string, fromDir: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readPackageJson(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

const CONDITIONS = ["browser", "import", "module", "default", "require"];

function pickConditional(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const picked = pickConditional(v);
      if (picked) return picked;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const condition of CONDITIONS) {
      if (condition in record) {
        const picked = pickConditional(record[condition]);
        if (picked) return picked;
      }
    }
  }
  return undefined;
}

/** Minimal package entry resolution, enough to read the first bytes of the file a bundler would use. */
function resolveEntry(pkgDir: string, pkg: PackageJson, subpath: string): string | undefined {
  const key = subpath ? `.${subpath}` : ".";
  let target: string | undefined;
  if (pkg.exports !== undefined) {
    const exportsField = pkg.exports;
    const isSubpathMap =
      exportsField !== null &&
      typeof exportsField === "object" &&
      !Array.isArray(exportsField) &&
      Object.keys(exportsField).some((k) => k.startsWith("."));
    if (isSubpathMap) {
      const map = exportsField as Record<string, unknown>;
      if (key in map) target = pickConditional(map[key]);
      else {
        for (const [pattern, value] of Object.entries(map)) {
          const star = pattern.indexOf("*");
          if (star === -1) continue;
          const prefix = pattern.slice(0, star);
          const suffix = pattern.slice(star + 1);
          if (key.startsWith(prefix) && key.endsWith(suffix)) {
            const matched = key.slice(prefix.length, key.length - suffix.length);
            target = pickConditional(value)?.replace("*", matched);
            break;
          }
        }
      }
    } else if (key === ".") {
      target = pickConditional(exportsField);
    }
  } else if (key === ".") {
    target = pkg.module ?? pkg.main ?? "index.js";
  } else {
    target = subpath.slice(1);
  }
  if (!target) return undefined;
  const base = path.join(pkgDir, target);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function startsWithUseClient(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer
      .subarray(0, read)
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
    return (
      /^(['"])use client\1/.test(head) || /^(['"])use strict\1;?\s*(['"])use client\2/.test(head)
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
