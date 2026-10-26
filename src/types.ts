import type { Skip } from "./analysis/skip.js";
import type { Warning } from "./analysis/timezone.js";

export type { Skip, SkipCode, SourceLocation } from "./analysis/skip.js";
export type { Warning, WarningCode } from "./analysis/timezone.js";

export type IslandInfo = {
  name: string;
  rootTag: string;
  props: string[];
  line: number;
  /** True for a whole helper component moved into the island file (not a generated island). */
  moved?: boolean;
};

export type FileResult = {
  file: string;
  /**
   * `"directive-removed"`: the file has no client-only code, and only its `"use client"` directive
   * is removed (with `removeUnusedDirectives`). Its `islands` is empty and `outputs` holds the file.
   */
  status: "split" | "directive-removed" | "skipped" | "unchanged";
  skipped?: Skip;
  islands: IslandInfo[];
  /** Share of JSX nodes that end up outside islands, 0..1. */
  staticRatio: number;
  /**
   * Gzip bytes saved; `conservative` is the headline "estimated" number. It assumes the other
   * splits the tool proposes for the project are applied too. `sharedWith` lists the ones that
   * remove some of the same code (each such dependency is counted once, divided between them), so
   * this saving depends on applying them as well.
   */
  bytesSaved?: { isolated: number; conservative: number; sharedWith?: string[] };
  /**
   * Why `bytesSaved` is missing although measurement was on (esbuild couldn't bundle a file). Only
   * splits with `minBytesSaved: 0` get here; otherwise the file is skipped as `measure-failed`.
   */
  measureError?: string;
  /**
   * Risks the change carries that don't make the tool skip it, for example date formatting that
   * now renders in the server's timezone. Only on changes.
   */
  warnings?: Warning[];
  /** Unified diff covering all touched/created files. */
  diff: string;
  /** Project-relative path -> new content, for every touched or created file. */
  outputs: Record<string, string>;
};

export type SplitResult = {
  files: FileResult[];
};

export type UserConfig = {
  include?: string[];
  exclude?: string[];
  clientOnlyPackages?: string[];
  serverSafePackages?: string[];
  serverSafeHooks?: string[];
  clientFileSuffix?: string;
  islandsDir?: string;
  minBytesSaved?: number;
  minStaticRatio?: number;
  prettier?: "auto" | false;
  mongoose?: { autoSerialize?: boolean };
  removeUnusedDirectives?: boolean;
};

export type ResolvedConfig = {
  include: string[];
  exclude: string[];
  clientOnlyPackages: string[];
  serverSafePackages: string[];
  serverSafeHooks: string[];
  clientFileSuffix: string;
  islandsDir: string | undefined;
  minBytesSaved: number;
  minStaticRatio: number;
  prettier: "auto" | false;
  mongoose: { autoSerialize: boolean };
  removeUnusedDirectives: boolean;
};

export type SplitOptions = {
  /** Project root (where tsconfig.json lives). Defaults to process.cwd(). */
  root?: string;
  /** Files or directories to consider, relative to root. Defaults to the config `include`. */
  paths?: string[];
  /**
   * Narrows the targets (from `paths` or `include`) to these files, relative to root. The CLI's
   * `--since` passes the files changed since a git ref.
   */
  only?: string[];
  /**
   * Files to leave as they are, relative to root: they're not analysed, and size estimates don't
   * assume they're split. The CLI's `--baseline` reads them from a file.
   */
  baseline?: string[];
  /** Write the outputs to disk. Default false. */
  write?: boolean;
  /** Overrides for the config file. */
  config?: UserConfig;
  /** Explicit config file path (relative to root). */
  configFile?: string;
  /** Skip loading a config file from disk. */
  noConfigFile?: boolean;
  /** Skip the esbuild size measurement (faster; bytesSaved is omitted and minBytesSaved is not applied). */
  measure?: boolean;
  /**
   * Repeat the analysis until no new change is found (default true). A split can make another file
   * splittable: a component imported only by a client component that is split becomes splittable
   * once its importer is a Server Component. Later passes see the earlier passes' outputs in memory.
   */
  iterate?: boolean;
  /** Called with each file result as soon as it is ready. */
  onFile?: (result: FileResult) => void;
};
