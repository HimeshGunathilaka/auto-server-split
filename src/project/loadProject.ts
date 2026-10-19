import { existsSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, ts } from "ts-morph";

export const IGNORED_DIRS = [
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
export function loadProject(root: string): LoadedProject {
  const configFile = ["tsconfig.json", "jsconfig.json"]
    .map((f) => path.join(root, f))
    .find((f) => existsSync(f));

  if (configFile) {
    const project = new Project({ tsConfigFilePath: configFile });
    const options = project.getCompilerOptions();
    if (path.basename(configFile) === "jsconfig.json" && options.allowJs === undefined) {
      // jsconfig.json implies allowJs.
      project.compilerOptions.set({ allowJs: true, checkJs: false });
    }
    return { project, root, configFile, compilerOptions: project.getCompilerOptions() };
  }

  const project = new Project({ compilerOptions: DEFAULT_COMPILER_OPTIONS });
  const files = fg.sync(["**/*.{ts,tsx,js,jsx,mts,cts}"], {
    cwd: root,
    ignore: IGNORE_GLOBS,
    absolute: true,
    dot: false,
  });
  for (const file of files) project.addSourceFileAtPath(file);
  project.resolveSourceFileDependencies();
  return { project, root, configFile: undefined, compilerOptions: project.getCompilerOptions() };
}

/** Source files that belong to the user's project (not node_modules, not declaration files). */
export function projectSourceFiles(loaded: LoadedProject): ts.SourceFile[] {
  return loaded.project
    .getSourceFiles()
    .map((sf) => sf.compilerNode)
    .filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes("/node_modules/"));
}
