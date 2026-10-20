import { createHash } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { BuildOptions, Message, Metafile } from "esbuild";
import { buildSync } from "esbuild";
import { packageNameOf } from "../analysis/clientPackages.js";
import type { ModuleGraph } from "../project/moduleGraph.js";

type BytesSaved = { isolated: number; conservative: number };

/** The saving, or why it couldn't be measured (esbuild couldn't bundle one of the files). */
export type Measurement = { bytesSaved: BytesSaved } | { error: string };

type BundleStats = { gzip: number; minified: number; inputs: Map<string, number> };

/** Bundles kept per run; an editor's ESLint process measures every edit, so this is bounded. */
const CACHE_LIMIT = 500;

const EMPTY_LOADERS = [
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
 * Estimates the client JavaScript saved by a split: bundle the original client file and
 * the generated island file with esbuild (react, react-dom and next external), and compare gzip sizes.
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
      external: ["react", "react/*", "react-dom", "react-dom/*", "next", "next/*"],
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
   * `isolated` = before − after. `conservative` also leaves out code that other client modules still
   * import (it ships anyway); gzip is apportioned by each input's share of the minified output.
   */
  measure(file: string, originalText: string, islandFile: string, islandText: string): Measurement {
    const before = this.bundle({ file, contents: originalText });
    if ("error" in before) return before;
    const after = this.bundle({ file: islandFile, contents: islandText });
    if ("error" in after) return after;
    const isolated = Math.max(0, before.gzip - after.gzip);

    const stillShipped = this.stillShippedElsewhere(file);
    let sharedBytes = 0;
    for (const [input, bytes] of before.inputs) {
      if (after.inputs.has(input)) continue;
      if (input === "<stdin>") continue;
      if (stillShipped(input)) sharedBytes += bytes;
    }
    const ratio = before.minified > 0 ? before.gzip / before.minified : 0;
    const conservative = Math.max(0, Math.round(isolated - sharedBytes * ratio));
    return { bytesSaved: { isolated, conservative: Math.min(conservative, isolated) } };
  }

  /** Packages and project modules imported by some other client module (they keep shipping). */
  private stillShippedElsewhere(file: string): (input: string) => boolean {
    const packages = new Set<string>();
    const localFiles = new Set<string>();
    for (const node of this.graph.nodes.values()) {
      if (node.file === file || !this.graph.isClient(node.file)) continue;
      for (const edge of node.edges) {
        if (edge.kind === "type") continue;
        if (edge.to) {
          if (edge.to !== file) localFiles.add(edge.to);
        } else if (edge.external) {
          packages.add(edge.external.packageName);
        }
      }
    }
    return (input: string) => {
      const marker = "node_modules/";
      const i = input.lastIndexOf(marker);
      if (i !== -1) return packages.has(packageNameOf(input.slice(i + marker.length)));
      return localFiles.has(path.resolve(this.root, input));
    };
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
