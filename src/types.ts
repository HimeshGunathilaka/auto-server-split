import type { RulesConfig } from "./analysis/rules.js";
import type { Skip, SkipCode } from "./analysis/skip.js";
import type { Warning, WarningCode } from "./analysis/warnings.js";
import type { FileRoute, RouteSaving } from "./measure/routes.js";

export type { Skip, SkipCode, SourceLocation } from "./analysis/skip.js";
export type { Warning, WarningCode } from "./analysis/warnings.js";
export type { RulesConfig } from "./analysis/rules.js";
export type { FileRoute, RouteLoad, RouteSaving } from "./measure/routes.js";

export type IslandInfo = {
  name: string;
  rootTag: string;
  props: string[];
  line: number;
  /** True for a whole helper component moved into the island file (not a generated island). */
  moved?: boolean;
  /**
   * True for an island that renders nothing and only runs effects no element uses; it's rendered
   * as the last child of the component's returned element. Its `rootTag` is `"effects"`.
   */
  effects?: boolean;
};

export type FileResult = {
  file: string;
  /**
   * `"directive-removed"`: the file has no client-only code, and only its `"use client"` directive
   * is removed (with `removeUnusedDirectives`). Its `islands` is empty and `outputs` holds the file.
   */
  status: "split" | "directive-removed" | "skipped" | "unchanged";
  /**
   * On changes: identifies the change across runs without its path or line numbers (the kind of
   * change, the component and its islands' names). Baselines, SARIF and GitLab reports use it, so a
   * moved file or shifted code isn't reported as new.
   */
  fingerprint?: string;
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
  /**
   * Changes to other files this one needs, project-relative: a later pass found it once they made
   * its importers Server Components (see `iterate`). Apply them in the same run.
   */
  requires?: string[];
  /**
   * The App Router routes that load this file and what the change saves on each (`bytesSaved`
   * when measuring): `"initial"` routes load it with the page, `"lazy"` ones later (`next/dynamic`,
   * `import()`). Like `bytesSaved`, it assumes the other proposed changes are applied too.
   */
  routes?: FileRoute[];
  /** Unified diff covering all touched/created files. */
  diff: string;
  /** Project-relative path -> new content, for every touched or created file. */
  outputs: Record<string, string>;
};

export type SplitResult = {
  files: FileResult[];
  /** Per App Router route: the changes on it and what they save together. */
  routes?: RouteSaving[];
  /** The run's numbers. */
  summary: RunSummary;
};

/** The numbers of a run (`SplitResult.summary`, `--json`). */
export type RunSummary = {
  /** Files the run looked at (`paths`, or the config's `include`). */
  filesScanned: number;
  /** Of those, the ones that start with `"use client"`: each has a result. */
  useClientFiles: number;
  /** Splits plus removed directives. */
  changes: number;
  splits: number;
  directivesRemoved: number;
  /** Islands the changes create. */
  islands: number;
  skipped: number;
  skippedByCode: Partial<Record<SkipCode, number>>;
  /** Estimated gzip bytes the changes save together (conservative); absent when not measured. */
  bytesSaved?: number;
  /** Changes whose saving couldn't be measured. */
  unmeasured: number;
  warnings: Partial<Record<WarningCode, number>>;
  /** App Router routes the changes affect. */
  routes: number;
  /** The route that saves the most up front. */
  bestRoute?: { route: string; initialSaved: number };
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
  outputExists?: "skip" | "alternate";
  rules?: RulesConfig;
  /** What fails `--check` (see docs/configuration.md#check). Gzip bytes, conservative estimates. */
  check?: {
    minSaving?: number;
    minRouteSaving?: number;
    maxRecoverable?: number;
    maxNewBoundaries?: number;
  };
  /** Commands `auto-server-split verify` runs after applying changes (type checker, tests, build). */
  verify?: { commands: string[] };
  /**
   * In a workspace root's config: the apps `--workspace` runs on (globs, relative to the root).
   * Without it, the workspace's Next.js App Router apps are found from its package globs.
   */
  projects?: string[];
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
  outputExists: "skip" | "alternate";
  rules: Required<RulesConfig>;
  check: NonNullable<UserConfig["check"]>;
  verify: { commands: string[] };
  projects: string[] | undefined;
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
  /** Work out which App Router routes each change affects (default true). */
  routes?: boolean;
  /**
   * A Next.js analyzer snapshot to take route sizes from: the JSON Lines `next analyze export`
   * prints, or a directory (the app, its `.next`, or `.next/diagnostics/analyze`) whose latest
   * snapshot is exported with the project's `next`. Without it, sizes are esbuild estimates.
   */
  analyzeSnapshot?: string;
};
