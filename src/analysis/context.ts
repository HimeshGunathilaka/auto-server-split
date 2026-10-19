import type { ts } from "ts-morph";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { ResolvedConfig } from "../types.js";
import type { FrameworkAdapter } from "./framework.js";
import type { ModuleSafety } from "./moduleSafety.js";

/** Everything the pure analysis needs. Built once per file by the orchestrator; no I/O happens below this. */
export type AnalysisContext = {
  program: ts.Program;
  checker: ts.TypeChecker;
  sf: ts.SourceFile;
  /** Absolute path of the file being analysed. */
  file: string;
  graph: ModuleGraph;
  config: ResolvedConfig;
  framework: FrameworkAdapter;
  /** True for .js/.jsx files: types are inferred, so the boundary rules are stricter. */
  isJs: boolean;
  moduleSafety: ModuleSafety;
};

export function lineCol(sf: ts.SourceFile, pos: number): { line: number; column: number } {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

export function locOf(ctx: { sf: ts.SourceFile }, node: ts.Node): { line: number; column: number } {
  return lineCol(ctx.sf, node.getStart(ctx.sf));
}
