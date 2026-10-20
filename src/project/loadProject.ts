import { existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, ts } from "ts-morph";

const IGNORED_DIRS = [
  "node_modules",
  ".next",
  ".git",
  "dist",
  "out",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
];
export const IGNORE_GLOBS = IGNORED_DIRS.map((d) => `**/${d}/**`);

export type LoadedProject = {
  project: Project;
  root: string;
  /** tsconfig.json / jsconfig.json used, if any. */
  configFile: string | undefined;
  compilerOptions: ts.CompilerOptions;
  /**
   * Lazy projects (used by the ESLint rule without typed linting) only load the files the
   * analysis touches; this lists every file the tsconfig covers, for the module graph.
   */
  lazyFileNames?: string[];
};

type LoadOptions = {
  /** Explicit tsconfig/jsconfig path (default: the one in `root`). */
  tsconfig?: string;
  lazy?: boolean;
};

/** Compiler options used when the project has no tsconfig/jsconfig (mirrors create-next-app). */
export const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.dom.d.ts", "lib.dom.iterable.d.ts", "lib.esnext.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  allowJs: true,
  esModuleInterop: true,
  isolatedModules: true,
  resolveJsonModule: true,
  noEmit: true,
};

/**
 * Builds one ts-morph Project for the whole run. Path aliases resolve through TypeScript's own
 * module resolution, so `@/lib/x` works exactly as it does for `tsc`.
 */
export function loadProject(root: string, options: LoadOptions = {}): LoadedProject {
  const configFile =
    options.tsconfig ??
    ["tsconfig.json", "jsconfig.json"].map((f) => path.join(root, f)).find((f) => existsSync(f));

  if (configFile) {
    const isJsConfig = path.basename(configFile) === "jsconfig.json";
    const project = new Project({
      tsConfigFilePath: configFile,
      skipAddingFilesFromTsConfig: options.lazy === true,
      ...(isJsConfig ? { compilerOptions: { allowJs: true, checkJs: false } } : {}),
    });
    const compilerOptions = project.getCompilerOptions();
    if (!options.lazy) return { project, root, configFile, compilerOptions };
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(configFile, ts.sys.readFile).config,
      ts.sys,
      path.dirname(configFile),
      isJsConfig ? { allowJs: true } : undefined,
      configFile,
    );
    const lazyFileNames = parsed.fileNames.map((f) => path.resolve(f));
    // Ambient declarations (e.g. `declare module "*.module.css"`) apply to every file: load them up front.
    for (const file of lazyFileNames) if (file.endsWith(".d.ts")) project.addSourceFileAtPath(file);
    return { project, root, configFile, compilerOptions, lazyFileNames };
  }

  const project = new Project({ compilerOptions: DEFAULT_COMPILER_OPTIONS });
  const files = fg.sync(["**/*.{ts,tsx,js,jsx,mts,cts}"], {
    cwd: root,
    ignore: IGNORE_GLOBS,
    absolute: true,
    dot: false,
  });
  if (options.lazy)
    return {
      project,
      root,
      configFile: undefined,
      compilerOptions: DEFAULT_COMPILER_OPTIONS,
      lazyFileNames: files.map((f) => path.resolve(f)),
    };
  for (const file of files) project.addSourceFileAtPath(file);
  project.resolveSourceFileDependencies();
  return { project, root, configFile: undefined, compilerOptions: project.getCompilerOptions() };
}

/** In a lazy project, loads the given files (and whatever they import) before analysis. */
export function ensureLoaded(loaded: LoadedProject, files: Iterable<string>): void {
  if (!loaded.lazyFileNames) return;
  let added = false;
  for (const file of files) {
    if (!loaded.project.getSourceFile(file) && existsSync(file)) {
      loaded.project.addSourceFileAtPath(file);
      added = true;
    }
  }
  if (added) loaded.project.resolveSourceFileDependencies();
}

/** Source files that belong to the user's project (not node_modules, not declaration files). */
export function projectSourceFiles(loaded: LoadedProject): ts.SourceFile[] {
  return loaded.project
    .getSourceFiles()
    .map((sf) => sf.compilerNode)
    .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));
}
