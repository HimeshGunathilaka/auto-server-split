import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { BuildOptions, Message, Metafile } from "esbuild";
import { buildSync } from "esbuild";
import { packageNameOf } from "../analysis/clientPackages.js";
import type { ModuleGraph } from "../project/moduleGraph.js";

type BytesSaved = { isolated: number; conservative: number };

/**
 * A file a run would change, as the estimate sees it: its text before and its island's text after.
 * Without an island, the file's `"use client"` directive is removed and nothing replaces it.
 */
export type SplitCandidate = {
  file: string;
  originalText: string;
  island?: { file: string; text: string };
};

/**
 * The saving, or why it couldn't be measured (esbuild couldn't bundle one of the files).
 * `sharedWith` lists the other candidates that remove some of the same code from the client.
 */
export type Measurement = { bytesSaved: BytesSaved; sharedWith: string[] } | { error: string };

type BundleStats = {
  gzip: number;
  minified: number;
  /** Minified bytes each input contributes. */
  inputs: Map<string, number>;
  /** Package files -> the packages imported by project code that pull them in. */
  pulledInBy: Map<string, Set<string>>;
};

const EMPTY_BUNDLE: BundleStats = {
  gzip: 0,
  minified: 0,
  inputs: new Map(),
  pulledInBy: new Map(),
};

/** Bundles kept per run; an editor's ESLint process measures every edit, so this is bounded. */
const CACHE_LIMIT = 500;

/**
 * Imports that ship no client JS (or not enough to matter for the estimate). esbuild matches the
 * longest extension, and its built-in `.module.css` → `local-css` loader would otherwise win over
 * `.css` and fail ("without an output path configured"), so CSS Modules are listed explicitly.
 */
const EMPTY_LOADERS = [
  ".module.css",
  ".module.scss",
  ".module.sass",
  ".module.less",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
];

/**
 * Estimates the client JavaScript saved by splits: bundle each original client file and its
 * generated island file with esbuild (react, react-dom, next and `"use server"` modules external),
 * and compare gzip sizes.
 * Synchronous, so the CLI and the ESLint rule (which can't await) share it.
 */
export class BundleMeasurer {
  private readonly cache = new Map<string, BundleStats | { error: string }>();
  private readonly configFile: string | undefined;

  constructor(
    private readonly root: string,
    private readonly graph: ModuleGraph,
    tsconfig?: string,
  ) {
    this.configFile = tsconfig;
  }

  private bundle(entry: { file: string; contents: string }): BundleStats | { error: string } {
    const key = createHash("sha256")
      .update(entry.file)
      .update("\0")
      .update(entry.contents)
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const ext = path.extname(entry.file).slice(1);
    const loader = (["tsx", "ts", "jsx", "js"].includes(ext) ? ext : "tsx") as
      "tsx" | "ts" | "jsx" | "js";
    const options: BuildOptions = {
      stdin: {
        contents: entry.contents,
        resolveDir: path.dirname(entry.file),
        sourcefile: entry.file,
        loader,
      },
      absWorkingDir: this.root,
      platform: "browser",
      bundle: true,
      minify: true,
      write: false,
      metafile: true,
      format: "esm",
      jsx: "automatic",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      external: [
        "react",
        "react/*",
        "react-dom",
        "react-dom/*",
        "next",
        "next/*",
        ...this.serverActionFiles(),
      ],
      loader: Object.fromEntries(EMPTY_LOADERS.map((e) => [e, "empty" as const])),
      ...(this.configFile ? { tsconfig: this.configFile } : {}),
    };
    let stats: BundleStats | { error: string };
    try {
      const result = buildSync(options);
      const output =
        result.outputFiles?.find((f) => f.path.endsWith(".js")) ?? result.outputFiles?.[0];
      stats = output
        ? {
            gzip: gzipSync(output.contents).length,
            minified: output.contents.length,
            inputs: inputBytes(result.metafile),
            pulledInBy: packageOwners(result.metafile),
          }
        : { error: "esbuild produced no output" };
    } catch (error) {
      stats = { error: describeBuildError(error) };
    }
    if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, stats);
    return stats;
  }

  /**
   * Estimates each candidate's saving, assuming every candidate in the list is split.
   * `isolated` = before − after. `conservative` also leaves out code that still ships after all of
   * these splits (some other client module imports it), and divides code that several of the
   * splits remove together between them, so the candidates' savings add up to the total.
   * gzip is apportioned by each input's share of the minified output.
   */
  measure(candidates: readonly SplitCandidate[]): Map<string, Measurement> {
    const bundles = new Map<
      string,
      { before: BundleStats; after: BundleStats } | { error: string }
    >();
    for (const c of candidates) {
      const before = this.bundle({ file: c.file, contents: c.originalText });
      if ("error" in before) {
        bundles.set(c.file, before);
        continue;
      }
      const after = c.island
        ? this.bundle({ file: c.island.file, contents: c.island.text })
        : EMPTY_BUNDLE;
      bundles.set(c.file, "error" in after ? after : { before, after });
    }

    const shipped = this.graph.clientGraphAfter(candidates);
    const stillShipped = (input: string, stats: BundleStats): boolean => {
      const pkg = packageOfInput(input);
      if (pkg === undefined) return shipped.files.has(path.resolve(this.root, input));
      if (shipped.packages.has(pkg)) return true;
      return [...(stats.pulledInBy.get(input) ?? [])].some((p) => shipped.packages.has(p));
    };
    // Which candidates remove each input from the client, and what each one leaves shipping.
    const removedBy = new Map<string, string[]>();
    const keptBytes = new Map<string, number>();
    for (const [file, b] of bundles) {
      if ("error" in b) continue;
      let kept = 0;
      for (const [input, bytes] of b.before.inputs) {
        if (input === "<stdin>" || b.after.inputs.has(input)) continue;
        if (stillShipped(input, b.before)) kept += bytes;
        else if (removedBy.has(input)) removedBy.get(input)?.push(file);
        else removedBy.set(input, [file]);
      }
      keptBytes.set(file, kept);
    }

    const out = new Map<string, Measurement>();
    for (const [file, b] of bundles) {
      if ("error" in b) {
        out.set(file, b);
        continue;
      }
      const { before, after } = b;
      const isolated = Math.max(0, before.gzip - after.gzip);
      let notCounted = keptBytes.get(file) ?? 0;
      const sharedWith = new Set<string>();
      for (const [input, bytes] of before.inputs) {
        const by = removedBy.get(input);
        if (!by?.includes(file) || by.length === 1) continue;
        notCounted += bytes * (1 - 1 / by.length);
        for (const other of by) if (other !== file) sharedWith.add(other);
      }
      const ratio = before.minified > 0 ? before.gzip / before.minified : 0;
      const conservative = Math.max(0, Math.round(isolated - notCounted * ratio));
      out.set(file, {
        bytesSaved: { isolated, conservative: Math.min(conservative, isolated) },
        sharedWith: [...sharedWith].sort(),
      });
    }
    return out;
  }

  /**
   * `"use server"` modules, as resolved paths (esbuild matches path-like externals after
   * resolution, so aliases like `@/app/actions` are covered). In a client bundle the framework
   * replaces their imports with small server-reference stubs; following them would pull in the
   * server code (database drivers, Node built-ins) and usually fail to bundle.
   */
  private serverActionFiles(): string[] {
    const files: string[] = [];
    for (const node of this.graph.nodes.values()) {
      if (node.directive !== "use server") continue;
      files.push(node.file);
      try {
        const real = realpathSync(node.file);
        if (real !== node.file) files.push(real);
      } catch {
        // A file that vanished since the graph was built can't be imported either.
      }
    }
    return files;
  }
}

/** "esbuild: components/Card.tsx:3:20: Could not resolve "virtual-fmt"" */
function describeBuildError(error: unknown): string {
  const first = (error as { errors?: Message[] }).errors?.[0];
  if (!first) return `esbuild: ${error instanceof Error ? error.message : String(error)}`;
  const loc = first.location
    ? `${first.location.file}:${first.location.line}:${first.location.column + 1}: `
    : "";
  return `esbuild: ${loc}${first.text}`;
}

function inputBytes(metafile: Metafile | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!metafile) return out;
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, info] of Object.entries(output.inputs)) {
      out.set(input, (out.get(input) ?? 0) + info.bytesInOutput);
    }
  }
  return out;
}

/** The package an esbuild input belongs to (`node_modules/.pnpm/x@1/node_modules/x/a.js` -> x). */
function packageOfInput(input: string): string | undefined {
  const marker = "node_modules/";
  const i = input.lastIndexOf(marker);
  return i === -1 ? undefined : packageNameOf(input.slice(i + marker.length));
}

/**
 * For every package file in a bundle, the packages project code imports that pull it in: date-fns's
 * own files get `date-fns`, and a dependency of `marked` gets `marked`. Such a file keeps shipping
 * while any of those packages does.
 */
function packageOwners(metafile: Metafile | undefined): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  if (!metafile) return owners;
  const pending: string[] = [];
  const own = (input: string, owner: string) => {
    const set = owners.get(input) ?? new Set<string>();
    if (set.has(owner)) return;
    set.add(owner);
    owners.set(input, set);
    pending.push(input);
  };
  for (const [input, info] of Object.entries(metafile.inputs)) {
    if (packageOfInput(input) !== undefined) continue;
    for (const imported of info.imports) {
      const pkg = imported.external ? undefined : packageOfInput(imported.path);
      if (pkg !== undefined) own(imported.path, pkg);
    }
  }
  for (let input = pending.pop(); input !== undefined; input = pending.pop()) {
    const from = owners.get(input) ?? new Set<string>();
    for (const imported of metafile.inputs[input]?.imports ?? []) {
      if (imported.external || packageOfInput(imported.path) === undefined) continue;
      for (const owner of from) own(imported.path, owner);
    }
  }
  return owners;
}
