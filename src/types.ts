import type { Skip } from "./analysis/skip.js";

export type { Skip, SkipCode, SourceLocation } from "./analysis/skip.js";

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
  status: "split" | "skipped" | "unchanged";
  skipped?: Skip;
  islands: IslandInfo[];
  /** Share of JSX nodes that end up outside islands, 0..1. */
  staticRatio: number;
  /** Gzip bytes saved; `conservative` is the headline "estimated" number. */
  bytesSaved?: { isolated: number; conservative: number };
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
  serverSafeHooks?: string[];
  clientFileSuffix?: string;
  islandsDir?: string;
  minBytesSaved?: number;
  minStaticRatio?: number;
  prettier?: "auto" | false;
  mongoose?: { autoSerialize?: boolean };
};

export type ResolvedConfig = {
  include: string[];
  exclude: string[];
  clientOnlyPackages: string[];
  serverSafeHooks: string[];
  clientFileSuffix: string;
  islandsDir: string | undefined;
  minBytesSaved: number;
  minStaticRatio: number;
  prettier: "auto" | false;
  mongoose: { autoSerialize: boolean };
};

export type SplitOptions = {
  /** Project root (where tsconfig.json lives). Defaults to process.cwd(). */
  root?: string;
  /** Files or directories to consider, relative to root. Defaults to the config `include`. */
  paths?: string[];
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
  /** Called with each file result as soon as it is ready. */
  onFile?: (result: FileResult) => void;
};
