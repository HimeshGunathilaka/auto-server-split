import path from "node:path";
import type { Directive } from "../analysis/directives.js";
import type { AppRoute } from "../frameworks/next.js";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { ExternalKind, ModuleEdge } from "../project/moduleTypes.js";
import type { BundleMeasurer, SplitCandidate } from "./bundleSize.js";
import { packageOfInput } from "./bundleSize.js";
import type { AnalyzerSnapshot } from "./nextAnalyze.js";
import { moduleKey } from "./nextAnalyze.js";

/** How a route loads a file: with the page, or later (`next/dynamic`, `import()`). */
export type RouteLoad = "initial" | "lazy";

/** One route a change affects, and what it saves there. */
export type FileRoute = {
  route: string;
  load: RouteLoad;
  /** Gzip bytes of client JavaScript the route stops loading because of this change. */
  bytesSaved?: number;
};

/** What a run's changes save on one route. */
export type RouteSaving = {
  route: string;
  /** The run's changes on this route (relative paths). */
  files: string[];
  /**
   * Gzip bytes the route stops loading with the page, and later (lazy chunks), because of those
   * changes: the sum of their `routes[].bytesSaved` (each assumes the other proposed changes too).
   */
  initialSaved?: number;
  lazySaved?: number;
  /** The route's initial client JavaScript before the changes, from an analyzer snapshot. */
  initialBytes?: number;
  /** Where the sizes come from: Next.js's analyzer, or esbuild bundles of the changed files. */
  source?: "next-analyze" | "esbuild";
};

/** External imports that put code in the client bundle (React and Next ship with every page). */
const SHIPPING: ReadonlySet<ExternalKind> = new Set([
  "client-list",
  "neutral",
  "server-safe-list",
  "react-unknown",
  "use-client-entry",
  "css-in-js",
]);

export type View = {
  directive(file: string): Directive | undefined;
  edges(file: string): readonly ModuleEdge[];
};

/** A route's client modules, as keys (project paths and package names), up front and later. */
type RouteModules = { initial: Set<string>; lazy: Set<string> };

/**
 * The client modules a route loads, from its entry files: Server Components are followed until a
 * `"use client"` module, which (and everything it imports) is client code. `import()` and
 * `next/dynamic` make what they load lazy.
 */
export function routeModules(root: string, view: View, entries: readonly string[]): RouteModules {
  const initialRoots: string[] = [];
  const lazyRoots: string[] = [];
  /** Packages with a "use client" entry that Server Components render (client references). */
  const clientEntries = { initial: new Set<string>(), lazy: new Set<string>() };
  const server = new Set<string>();
  const walkServer = (file: string): void => {
    if (server.has(file)) return;
    server.add(file);
    for (const edge of view.edges(file)) {
      if (edge.kind !== "type" && edge.external?.kind === "use-client-entry")
        clientEntries[edge.kind === "dynamic" ? "lazy" : "initial"].add(edge.external.packageName);
      if (edge.kind === "type" || !edge.to) continue;
      const directive = view.directive(edge.to);
      if (directive === "use client")
        (edge.kind === "dynamic" ? lazyRoots : initialRoots).push(edge.to);
      else walkServer(edge.to);
    }
  };
  for (const entry of entries) {
    if (view.directive(entry) === "use client") initialRoots.push(entry);
    else walkServer(entry);
  }
  /** Client modules reachable from `roots`; `import()`s are followed (lazy) or set aside. */
  const walkClient = (roots: string[], into: Set<string>, skip: Set<string>, lazy: boolean) => {
    const seen = new Set<string>();
    const pending = [...roots];
    for (let file = pending.pop(); file; file = pending.pop()) {
      if (seen.has(file) || skip.has(file)) continue;
      seen.add(file);
      into.add(moduleKey(root, file));
      for (const edge of view.edges(file)) {
        if (edge.kind === "type") continue;
        if (edge.to) {
          // A Server Action is a reference in the client bundle, not its code.
          if (view.directive(edge.to) === "use server") continue;
          if (edge.kind === "dynamic" && !lazy) lazyRoots.push(edge.to);
          else pending.push(edge.to);
        } else if (edge.external && SHIPPING.has(edge.external.kind)) {
          into.add(edge.external.packageName);
        }
      }
    }
    return seen;
  };
  const initial = new Set<string>(clientEntries.initial);
  const initialFiles = walkClient(initialRoots, initial, new Set(), false);
  const lazy = new Set<string>(clientEntries.lazy);
  walkClient(lazyRoots, lazy, initialFiles, true);
  for (const key of initial) lazy.delete(key);
  return { initial, lazy };
}

/** The module graph with `changes` applied: changed files become server modules, islands roots. */
function viewAfter(graph: ModuleGraph, changes: readonly SplitCandidate[]): View {
  const overrides = new Map<string, { directive: Directive | undefined; edges: ModuleEdge[] }>();
  for (const c of changes) {
    // Copied: both lists are shared (the graph's own, and a cache of parsed texts).
    const edges = [
      ...(c.serverText ? graph.edgesOfText(c.file, c.serverText) : graph.edgesFrom(c.file)),
    ];
    if (c.island) {
      overrides.set(c.island.file, {
        directive: "use client",
        edges: graph.edgesOfText(c.island.file, c.island.text),
      });
      edges.push({
        from: c.file,
        specifier: c.island.file,
        kind: "static",
        to: c.island.file,
        external: undefined,
        line: 0,
      });
    }
    overrides.set(c.file, { directive: undefined, edges });
  }
  return {
    directive: (file) =>
      overrides.has(file) ? overrides.get(file)?.directive : graph.nodes.get(file)?.directive,
    edges: (file) => overrides.get(file)?.edges ?? graph.edgesFrom(file),
  };
}

/**
 * Per route, what the changes save: the client modules (and packages) the route loads before them
 * and no longer loads after, minus the island files it loads instead. Sizes come from the analyzer
 * snapshot for the route when there is one, otherwise from the esbuild bundles of the changed files
 * (each module's share of its bundle's gzip size). A module several changes remove from a route is
 * divided between them, so a route's per-file savings add up to its total. `changes` are all the
 * changes the estimate assumes.
 */
export function routeSavings(input: {
  root: string;
  graph: ModuleGraph;
  routes: readonly AppRoute[];
  changes: readonly SplitCandidate[];
  /** The changes results are reported for (the run's own); route totals add up theirs. */
  reported: ReadonlySet<string>;
  measurer: BundleMeasurer | undefined;
  snapshot: AnalyzerSnapshot | undefined;
}): { files: Map<string, FileRoute[]>; routes: RouteSaving[] } {
  const { root, graph, changes, measurer, snapshot } = input;
  const key = (file: string) => moduleKey(root, file);
  const inputKey = (inputPath: string) =>
    packageOfInput(inputPath) ?? key(path.resolve(root, inputPath));

  // Sizes and ownership from the bundles the estimate already built.
  const bytes = new Map<string, number>();
  const keysOf = new Map<string, Set<string>>();
  const ownedBy = new Map<string, Set<string>>();
  const measured = Boolean(measurer);
  for (const c of measurer ? changes : []) {
    const bundles = [
      { file: c.file, contents: c.originalText },
      ...(c.island ? [{ file: c.island.file, contents: c.island.text }] : []),
    ];
    for (const entry of bundles) {
      const stats = measurer?.bundle(entry);
      if (!stats || "error" in stats) continue;
      const ratio = stats.minified > 0 ? stats.gzip / stats.minified : 0;
      const sums = new Map<string, number>();
      for (const [inputPath, size] of stats.inputs) {
        const k = inputPath === "<stdin>" ? key(entry.file) : inputKey(inputPath);
        sums.set(k, (sums.get(k) ?? 0) + size * ratio);
      }
      for (const [k, size] of sums) bytes.set(k, Math.max(bytes.get(k) ?? 0, size));
      if (entry.file !== c.file) continue;
      keysOf.set(c.file, new Set(sums.keys()));
      for (const [inputPath, owners] of stats.pulledInBy) {
        const pkg = inputKey(inputPath);
        const set = ownedBy.get(pkg) ?? new Set<string>();
        for (const owner of owners) if (owner !== pkg) set.add(owner);
        ownedBy.set(pkg, set);
      }
    }
  }
  /** Adds the packages that packages in `keys` pull in (a dependency of `marked` ships with it). */
  const withDependencies = (keys: Set<string>): Set<string> => {
    for (let grew = true; grew;) {
      grew = false;
      for (const [pkg, owners] of ownedBy) {
        if (keys.has(pkg)) continue;
        if ([...owners].some((o) => keys.has(o))) {
          keys.add(pkg);
          grew = true;
        }
      }
    }
    return keys;
  };

  const before: View = {
    directive: (file) => graph.nodes.get(file)?.directive,
    edges: (file) => graph.edgesFrom(file),
  };
  const after = viewAfter(graph, changes);
  const files = new Map<string, FileRoute[]>();
  const summaries: RouteSaving[] = [];
  for (const route of input.routes) {
    const was = routeModules(root, before, route.entries);
    const is = routeModules(root, after, route.entries);
    const onRoute = changes.filter(
      (c) => was.initial.has(key(c.file)) || was.lazy.has(key(c.file)),
    );
    if (onRoute.length === 0) continue;
    const fromSnapshot = snapshot?.routes.get(route.route);
    // Per change and load, what it removes from the route (shared modules divided).
    const saved: Record<RouteLoad, Map<string, number>> = { initial: new Map(), lazy: new Map() };
    for (const load of ["initial", "lazy"] as const) {
      const wasKeys = withDependencies(new Set(was[load]));
      const isKeys = withDependencies(new Set(is[load]));
      const sizeOf = (k: string) =>
        fromSnapshot ? (fromSnapshot[load].get(k) ?? 0) : (bytes.get(k) ?? 0);
      const add = (file: string, size: number) =>
        saved[load].set(file, (saved[load].get(file) ?? 0) + size);
      for (const k of wasKeys) {
        if (isKeys.has(k)) continue;
        const by = onRoute.filter((c) => key(c.file) === k || keysOf.get(c.file)?.has(k));
        for (const c of by) add(c.file, sizeOf(k) / by.length);
      }
      // The island files the route loads instead (not in any snapshot: always estimated).
      for (const c of onRoute) {
        if (!c.island || !isKeys.has(key(c.island.file)) || wasKeys.has(key(c.island.file)))
          continue;
        add(c.file, -(bytes.get(key(c.island.file)) ?? 0));
      }
    }
    const reported = onRoute.filter((c) => input.reported.has(c.file));
    for (const c of reported) {
      const load: RouteLoad = was.initial.has(key(c.file)) ? "initial" : "lazy";
      const total = (saved.initial.get(c.file) ?? 0) + (saved.lazy.get(c.file) ?? 0);
      const list = files.get(c.file) ?? [];
      list.push({
        route: route.route,
        load,
        ...(measured ? { bytesSaved: Math.max(0, Math.round(total)) } : {}),
      });
      files.set(c.file, list);
    }
    if (reported.length === 0) continue;
    const sum = (load: RouteLoad) =>
      Math.max(0, Math.round(reported.reduce((n, c) => n + (saved[load].get(c.file) ?? 0), 0)));
    summaries.push({
      route: route.route,
      files: reported.map((c) => key(c.file)).sort(),
      ...(measured
        ? {
            initialSaved: sum("initial"),
            lazySaved: sum("lazy"),
            source: fromSnapshot ? ("next-analyze" as const) : ("esbuild" as const),
          }
        : {}),
      ...(fromSnapshot ? { initialBytes: fromSnapshot.initialBytes } : {}),
    });
  }
  return { files, routes: summaries };
}
