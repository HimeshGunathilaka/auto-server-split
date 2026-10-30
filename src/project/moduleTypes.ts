import type { Directive } from "../analysis/directives.js";

/** How an external (non-project) specifier was classified. See project/packages.ts. */
export type ExternalKind =
  | "builtin"
  | "react"
  | "react-dom"
  | "framework"
  | "css-in-js"
  | "client-list"
  | "client-only-marker"
  | "server-only-marker"
  | "use-client-entry"
  | "server-safe-list"
  | "neutral"
  | "react-unknown"
  | "unresolved"
  | "stylesheet"
  | "css-module"
  | "asset"
  | "json";

export type ExternalModuleInfo = {
  specifier: string;
  packageName: string;
  kind: ExternalKind;
  detail?: string;
};

export type EdgeKind = "static" | "reexport" | "dynamic" | "type";

export type ModuleEdge = {
  from: string;
  specifier: string;
  kind: EdgeKind;
  /** Absolute path of the resolved project module, if the specifier points into the project. */
  to: string | undefined;
  /** Classification when the specifier is not a project module. */
  external: ExternalModuleInfo | undefined;
  /** 1-based line of the import in `from`. */
  line: number;
  /**
   * While the graph is built: the real path of a linked package's source (a workspace package)
   * that becomes `to` if the program loaded it.
   */
  linked?: string;
};

export type ModuleNode = {
  file: string;
  directive: Directive | undefined;
  /** False for files outside the TypeScript program (e.g. .js without allowJs, .mdx). */
  inProgram: boolean;
  edges: ModuleEdge[];
};
