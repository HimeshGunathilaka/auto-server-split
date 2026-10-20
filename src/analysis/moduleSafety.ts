import { ts } from "ts-morph";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { FrameworkAdapter } from "./framework.js";
import { buildImportTable } from "./importTable.js";
import { FileFacts, findEnvProblem } from "./taint.js";

type SafetyResult = { safe: boolean; reason?: string };

/**
 * Decides whether a project module without a directive can be evaluated and used inside a Server
 * Component: neither it nor anything it imports (stopping at "use client" modules, which become
 * client references) may use hooks, event handlers, browser globals, client-only packages,
 * createContext/class components, or server/browser-dependent env values. Memoised per run.
 */
export class ModuleSafety {
  private readonly cache = new Map<string, SafetyResult>();
  private readonly inProgress = new Set<string>();

  constructor(
    private readonly getProgram: () => ts.Program,
    private readonly graph: ModuleGraph,
    private readonly framework: FrameworkAdapter,
    private readonly serverSafeHooks: ReadonlySet<string>,
  ) {}

  check = (file: string): SafetyResult => {
    const cached = this.cache.get(file);
    if (cached) return cached;
    // Cycles: assume safe while the cycle is being evaluated; the other modules decide.
    if (this.inProgress.has(file)) return { safe: true };
    this.inProgress.add(file);
    try {
      const result = this.compute(file);
      this.cache.set(file, result);
      return result;
    } finally {
      this.inProgress.delete(file);
    }
  };

  private compute(file: string): SafetyResult {
    const node = this.graph.nodes.get(file);
    const rel = this.graph.rel(file);
    if (!node || !node.inProgram)
      return { safe: false, reason: `${rel} is outside the TypeScript project` };
    if (node.directive === "use client")
      return { safe: false, reason: `${rel} is a "use client" module` };
    if (node.directive === "use server") return { safe: true };

    const program = this.getProgram();
    const sf = program.getSourceFile(file);
    if (!sf) return { safe: false, reason: `${rel} is not in the program` };
    const checker = program.getTypeChecker();

    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        !statement.importClause &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const spec = statement.moduleSpecifier.text;
        if (!/\.(css|scss|sass|less)$/.test(spec)) {
          return { safe: false, reason: `${rel} has a side-effect import of ${spec}` };
        }
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
        const edge = this.graph.edgeFor(file, (statement.moduleSpecifier as ts.StringLiteral).text);
        if (edge?.to) {
          const target = this.graph.nodes.get(edge.to);
          if (target?.directive !== "use client" && target?.directive !== "use server") {
            const inner = this.check(edge.to);
            if (!inner.safe)
              return { safe: false, reason: inner.reason ?? `${rel} re-exports client code` };
          }
        } else if (
          edge?.external &&
          !["neutral", "server-safe-list", "json", "asset", "use-client-entry"].includes(
            edge.external.kind,
          )
        ) {
          return { safe: false, reason: `${rel} re-exports ${edge.specifier}` };
        }
      }
    }

    const imports = buildImportTable(sf, checker, this.graph);
    const facts = new FileFacts(
      sf,
      checker,
      imports,
      this.framework,
      this.check,
      this.serverSafeHooks,
    );
    const markers = facts.scanMarkers(sf);
    const first = markers[0];
    if (first) {
      const line = sf.getLineAndCharacterOfPosition(first.node.getStart(sf)).line + 1;
      return { safe: false, reason: `${rel}:${line} uses ${first.detail}` };
    }
    const env = findEnvProblem(sf, checker, this.framework);
    if (env) return { safe: false, reason: `${rel} ${env.message}` };

    let reason: string | undefined;
    const visit = (n: ts.Node): void => {
      if (reason) return;
      if (ts.isJsxAttribute(n)) {
        const name = n.name.getText(sf);
        if (/^on[A-Z]/.test(name) || name === "ref") reason = `${rel} attaches ${name} handlers`;
      }
      if (
        ts.isClassDeclaration(n) &&
        n.heritageClauses?.some((h) => /Component/.test(h.getText(sf)))
      ) {
        reason = `${rel} declares a class component`;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (reason) return { safe: false, reason };
    return { safe: true };
  }
}
