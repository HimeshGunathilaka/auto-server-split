import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import type { FileResult, RouteSaving } from "./types.js";

/** A project in a monorepo: an app the tool runs on separately. */
export type WorkspaceProject = {
  /** Absolute path. */
  dir: string;
  /** Relative to the workspace root (the prefix its results get). */
  name: string;
};

const NEXT_CONFIGS = [
  "next.config.ts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
  "next.config.mts",
];

/**
 * The workspace's package globs: `pnpm-workspace.yaml`'s `packages`, or `package.json`'s
 * `workspaces` (npm, Yarn, Bun; Turborepo uses these too). Undefined when it isn't a workspace.
 */
export function workspaceGlobs(root: string): string[] | undefined {
  const pnpm = path.join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    const globs: string[] = [];
    let inPackages = false;
    for (const line of readFileSync(pnpm, "utf8").split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (!inPackages) continue;
      const item = /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line);
      if (item?.[1]) globs.push(item[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
    return globs;
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    const ws = pkg.workspaces;
    const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(list) ? list.filter((g): g is string => typeof g === "string") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the tool can't run in a Yarn Plug'n'Play install, or undefined. TypeScript and esbuild resolve
 * packages from `node_modules`, which PnP doesn't create, so every file would fail its self-check.
 */
export function yarnPnpProblem(root: string): string | undefined {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".pnp.cjs"))) {
      if (existsSync(path.join(root, "node_modules")) || existsSync(path.join(dir, "node_modules")))
        return undefined;
      return "Yarn Plug'n'Play isn't supported: packages are resolved from node_modules. Set `nodeLinker: node-modules` in .yarnrc.yml and run yarn install.";
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** A Next.js App Router app: a Next config or a `next` dependency, and an `app/` directory. */
export function isNextApp(dir: string): boolean {
  if (!existsSync(path.join(dir, "app")) && !existsSync(path.join(dir, "src", "app"))) return false;
  if (NEXT_CONFIGS.some((c) => existsSync(path.join(dir, c)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  } catch {
    return false;
  }
}

/**
 * The projects to run on: `projects` globs (from the workspace root's config) when given, otherwise
 * the workspace packages that are Next.js App Router apps. Shared packages aren't projects of their
 * own: their components are analysed from the source, as part of each app that imports them, but
 * only an app's own files are changed.
 */
export function findWorkspaceProjects(
  root: string,
  projects: readonly string[] | undefined,
): { projects: WorkspaceProject[] } | { error: string } {
  const globs = projects ?? workspaceGlobs(root);
  if (!globs)
    return {
      error:
        "no workspace found (pnpm-workspace.yaml or package.json workspaces); list the apps with projects in the config or --project",
    };
  // `--project .` is the root itself; fast-glob rejects an empty pattern.
  const self = (g: string) => g === "" || g === "." || g === "./";
  const include = globs.filter((g) => !g.startsWith("!") && !self(g));
  const ignore = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  const dirs = [
    ...new Set([
      ...(globs.some(self) ? [root] : []),
      ...fg
        .sync(include, {
          cwd: root,
          onlyDirectories: true,
          ignore: ["**/node_modules/**", ...ignore],
          absolute: true,
        })
        .map((d) => path.resolve(d)),
    ]),
  ].sort();
  // A directory named outright must be an app; a glob (`packages/*`) just picks the apps it matches.
  if (projects) {
    const named = projects.filter(
      (g) => !g.startsWith("!") && (self(g) || !fg.isDynamicPattern(g)),
    );
    for (const g of named) {
      const dir = self(g) ? root : path.resolve(root, g);
      if (existsSync(dir) && !isNextApp(dir))
        return {
          error: `${self(g) ? "." : g} isn't a Next.js App Router app (it needs an app/ directory, and a next.config file or a next dependency)`,
        };
    }
  }
  const found = dirs.filter(isNextApp);
  return {
    projects: found.map((dir) => ({
      dir,
      name: path.relative(root, dir).split(path.sep).join("/"),
    })),
  };
}

/** A project's result with its paths made relative to the workspace root. */
export function prefixResult(result: FileResult, project: string): FileResult {
  const join = (file: string) => (project ? `${project}/${file}` : file);
  return {
    ...result,
    file: join(result.file),
    outputs: Object.fromEntries(Object.entries(result.outputs).map(([f, text]) => [join(f), text])),
    diff: result.diff.replace(/^(---|\+\+\+) ([ab])\//gm, `$1 $2/${project ? `${project}/` : ""}`),
    ...(result.requires ? { requires: result.requires.map(join) } : {}),
    ...(result.bytesSaved?.sharedWith
      ? { bytesSaved: { ...result.bytesSaved, sharedWith: result.bytesSaved.sharedWith.map(join) } }
      : {}),
    ...(result.routes && project
      ? { routes: result.routes.map((r) => ({ ...r, route: `${project}:${r.route}` })) }
      : {}),
  };
}

/** A project's route savings with the project in each route name. */
export function prefixRoutes(routes: readonly RouteSaving[], project: string): RouteSaving[] {
  if (!project) return [...routes];
  return routes.map((r) => ({
    ...r,
    route: `${project}:${r.route}`,
    files: r.files.map((f) => `${project}/${f}`),
  }));
}
