import { ts } from "ts-morph";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { FrameworkAdapter } from "./framework.js";
import { buildImportTable, classifyImportUsage } from "./importTable.js";
import { forEachValueRef, symbolOfRef } from "./refs.js";
import type { SafetyRules } from "./rules.js";
import { FileFacts, findEnvProblem } from "./taint.js";

/**
 * `clientReference`: the export is a Client Component (a `"use client"` module re-exported through
 * a barrel): rendering it as `<X />` is fine, using it as a value isn't.
 */
type SafetyResult = { safe: boolean; reason?: string; clientReference?: boolean };

/** External imports that are fine to evaluate on the server even though they aren't neutral. */
const EVALUATES_ON_SERVER = new Set(["use-client-entry", "builtin", "server-only-marker"]);

/**
 * Decides whether a project module without a directive can be used inside a Server Component.
 *
 * Without an export name, the whole module is checked: neither it nor anything it imports (stopping
 * at "use client" modules, which become client references) may use hooks, event handlers, browser
 * globals, client-only packages, createContext/class components, or server/browser-dependent env
 * values.
 *
 * With an export name, only what that export reaches must be: the module has to evaluate on the
 * server (its imports, and the code that runs on import), and then only the module-level
 * declarations the export uses are checked. So `formatTitle` stays usable on the server when the
 * same file also exports a `copyToClipboard()` that reads `navigator`. Importing a client-only React
 * API by name (`import { useState } from "react"`) makes the module fail to evaluate: Next.js
 * rejects such an import anywhere in the server graph, whether or not the export uses it.
 * Memoised per run.
 */
export class ModuleSafety {
  private readonly cache = new Map<string, SafetyResult>();
  /** Results that relied on a check still in progress (a cycle); dropped when it finishes. */
  private readonly provisional = new Map<string, SafetyResult>();
  private readonly inProgress = new Set<string>();
  /** In-progress checks whose assumed answer the current computation used. */
  private assumed = new Set<string>();

  constructor(
    private readonly getProgram: () => ts.Program,
    private readonly graph: ModuleGraph,
    private readonly framework: FrameworkAdapter,
    private readonly serverSafeHooks: ReadonlySet<string>,
    private readonly rules?: SafetyRules,
  ) {}

  check = (file: string, exportName?: string): SafetyResult =>
    this.memo(`${file}\0${exportName ?? "*"}`, () =>
      exportName === undefined ? this.compute(file) : this.computeExport(file, exportName),
    );

  private memo(key: string, compute: () => SafetyResult): SafetyResult {
    const cached = this.cache.get(key) ?? this.provisional.get(key);
    if (cached) return cached;
    // Cycles: assume safe while the cycle is being evaluated; the other modules decide. A result
    // that relied on that assumption about another check is only cached once that check is done.
    if (this.inProgress.has(key)) {
      this.assumed.add(key);
      return { safe: true };
    }
    this.inProgress.add(key);
    const outer = this.assumed;
    this.assumed = new Set();
    try {
      const result = compute();
      this.assumed.delete(key);
      (this.assumed.size === 0 ? this.cache : this.provisional).set(key, result);
      return result;
    } finally {
      this.inProgress.delete(key);
      for (const k of this.assumed) if (k !== key) outer.add(k);
      this.assumed = outer;
      if (this.inProgress.size === 0) this.provisional.clear();
    }
  }

  /** The module's node and source file, or why it can't be used on the server at all. */
  private load(
    file: string,
  ):
    | { kind: "directive"; result: SafetyResult }
    | { kind: "source"; sf: ts.SourceFile; program: ts.Program }
    | { kind: "unsafe"; result: SafetyResult } {
    const node = this.graph.nodes.get(file);
    const rel = this.graph.rel(file);
    if (!node || !node.inProgram)
      return {
        kind: "unsafe",
        result: { safe: false, reason: `${rel} is outside the TypeScript project` },
      };
    if (node.directive === "use client")
      return { kind: "unsafe", result: { safe: false, reason: `${rel} is a "use client" module` } };
    if (node.directive === "use server") return { kind: "directive", result: { safe: true } };
    const program = this.getProgram();
    const sf = program.getSourceFile(file);
    if (!sf)
      return { kind: "unsafe", result: { safe: false, reason: `${rel} is not in the program` } };
    return { kind: "source", sf, program };
  }

  private facts(sf: ts.SourceFile, checker: ts.TypeChecker): FileFacts {
    const imports = buildImportTable(sf, checker, this.graph);
    return new FileFacts(
      sf,
      checker,
      imports,
      this.framework,
      this.check,
      this.serverSafeHooks,
      this.rules,
    );
  }

  private compute(file: string): SafetyResult {
    const loaded = this.load(file);
    if (loaded.kind !== "source") return loaded.result;
    const { sf, program } = loaded;
    const rel = this.graph.rel(file);
    const checker = program.getTypeChecker();

    const sideEffect = this.sideEffectImport(sf);
    if (sideEffect) return sideEffect;
    for (const statement of sf.statements) {
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

    const facts = this.facts(sf, checker);
    const markers = facts.scanMarkers(sf);
    const first = markers[0];
    if (first) {
      const line = sf.getLineAndCharacterOfPosition(first.node.getStart(sf)).line + 1;
      return { safe: false, reason: `${rel}:${line} uses ${first.detail}` };
    }
    const env = findEnvProblem(sf, checker, this.framework);
    if (env) return { safe: false, reason: `${rel} ${env.message}` };
    return renderProblem(sf, rel) ?? { safe: true };
  }

  /** A non-stylesheet side-effect import, which would run on the server. */
  private sideEffectImport(sf: ts.SourceFile): SafetyResult | undefined {
    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        !statement.importClause &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const spec = statement.moduleSpecifier.text;
        if (!/\.(css|scss|sass|less)$/.test(spec)) {
          return {
            safe: false,
            reason: `${this.graph.rel(sf.fileName)} has a side-effect import of ${spec}`,
          };
        }
      }
    }
    return undefined;
  }

  /**
   * Whether the module can be evaluated on the server: what it imports can be (a "use client"
   * module becomes a client reference), and the code that runs on import (outside functions)
   * doesn't touch hooks, browser globals or client-only imports.
   */
  private evaluates = (file: string): SafetyResult =>
    this.memo(`${file}\0#evaluate`, () => {
      const loaded = this.load(file);
      if (loaded.kind === "directive") return loaded.result;
      const node = this.graph.nodes.get(file);
      if (node?.directive === "use client") return { safe: true };
      if (loaded.kind !== "source") return loaded.result;
      const { sf, program } = loaded;
      const rel = this.graph.rel(file);
      const checker = program.getTypeChecker();
      const sideEffect = this.sideEffectImport(sf);
      if (sideEffect) return sideEffect;

      const imports = buildImportTable(sf, checker, this.graph);
      for (const binding of imports.bindings) {
        // Types are erased before the module runs, `import type` or not
        // (`import { AnchorHTMLAttributes } from "react"`).
        if (binding.typeOnly || isTypeOnlyImport(checker, binding.symbol)) continue;
        const line = sf.getLineAndCharacterOfPosition(binding.node.getStart(sf)).line + 1;
        if (binding.module.kind === "project") {
          const inner = this.evaluates(binding.module.file);
          if (!inner.safe) return inner;
          continue;
        }
        if (EVALUATES_ON_SERVER.has(binding.module.info.kind)) continue;
        const usage = classifyImportUsage(
          binding,
          undefined,
          false,
          this.framework,
          () => ({ safe: true }),
          this.rules,
        );
        if (usage.cls === "client-only")
          return { safe: false, reason: `${rel}:${line} imports ${usage.reason}` };
      }
      for (const statement of sf.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.moduleSpecifier ||
          statement.isTypeOnly
        )
          continue;
        const edge = this.graph.edgeFor(file, (statement.moduleSpecifier as ts.StringLiteral).text);
        if (edge?.to) {
          const inner = this.evaluates(edge.to);
          if (!inner.safe) return inner;
        } else if (
          edge?.external &&
          !["neutral", "server-safe-list", "json", "asset", "use-client-entry", "builtin"].includes(
            edge.external.kind,
          )
        ) {
          return { safe: false, reason: `${rel} re-exports ${edge.specifier}` };
        }
      }

      const facts = new FileFacts(
        sf,
        checker,
        imports,
        this.framework,
        this.check,
        this.serverSafeHooks,
        this.rules,
      );
      const onImport = importTimeCode(sf, checker)
        .flatMap(({ node, stop }) => facts.scanMarkers(node, stop))
        .find((m) => m.kind !== "nondeterministic");
      if (onImport) {
        const line = sf.getLineAndCharacterOfPosition(onImport.node.getStart(sf)).line + 1;
        return { safe: false, reason: `${rel}:${line} uses ${onImport.detail} when it's imported` };
      }
      return { safe: true };
    });

  private computeExport(file: string, exportName: string): SafetyResult {
    const loaded = this.load(file);
    if (loaded.kind !== "source") return loaded.result;
    const { sf, program } = loaded;
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    const exported = moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === exportName)
      : undefined;
    const target =
      exported && exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    const declarations = target?.declarations ?? [];
    const [first] = declarations;
    // Not found, or re-exported from a package: judge the module as a whole.
    if (!first) return this.check(file);
    const declFile = first.getSourceFile();
    if (declFile.isDeclarationFile || declarations.some((d) => d.getSourceFile() !== declFile))
      return this.check(file);

    const evaluates = this.evaluates(file);
    if (!evaluates.safe) return evaluates;
    const owner = declFile === sf ? sf : undefined;
    if (!owner) {
      // `export { x } from "./y"`: the export is y's, which has to evaluate and be safe itself.
      const ownerFile = this.graph.nodes.has(declFile.fileName)
        ? declFile.fileName
        : [...this.graph.nodes.keys()].find((f) => program.getSourceFile(f) === declFile);
      if (!ownerFile) return this.check(file);
      if (this.graph.nodes.get(ownerFile)?.directive === "use client")
        return {
          safe: false,
          clientReference: true,
          reason: `${exportName} is a Client Component from ${this.graph.rel(ownerFile)}`,
        };
      const ownerSymbol = checker.getSymbolAtLocation(declFile);
      const name = ownerSymbol
        ? checker
            .getExportsOfModule(ownerSymbol)
            .find(
              (s) =>
                s === target ||
                (s.flags & ts.SymbolFlags.Alias && checker.getAliasedSymbol(s) === target),
            )
            ?.getName()
        : undefined;
      return this.check(ownerFile, name);
    }

    const rel = this.graph.rel(file);
    const facts = this.facts(sf, checker);
    for (const statement of reachedStatements(sf, checker, declarations)) {
      const marker = facts.scanMarkers(statement)[0];
      if (marker) {
        const line = sf.getLineAndCharacterOfPosition(marker.node.getStart(sf)).line + 1;
        return { safe: false, reason: `${rel}:${line} uses ${marker.detail}` };
      }
      const env = findEnvProblem(statement, checker, this.framework);
      if (env) return { safe: false, reason: `${rel} ${env.message}` };
      const problem = renderProblem(statement, rel);
      if (problem) return problem;
    }
    return { safe: true };
  }
}

/**
 * The code that runs when the module is imported, as nodes to scan (each with what to leave out):
 * module-level statements and initializers; a class's heritage, decorators and static members;
 * every function that isn't the body of a declaration (a callback, an IIFE or an object method could
 * run on import); and the whole of each local function or class that import-time code refers to,
 * transitively. Only function declarations, functions assigned directly to a variable, and class
 * methods and instance members are left out, unless something that runs on import uses them.
 */
function importTimeCode(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
): { node: ts.Node; stop: ((n: ts.Node) => boolean) | undefined }[] {
  /** Function bodies and class members that only run when called (or instantiated). */
  const deferred = new Set<ts.Node>();
  /** What to scan when import-time code refers to a local function or class. */
  const whole = new Map<ts.Symbol, ts.Node>();
  const regions: ts.Node[] = [];
  const declare = (name: ts.Node | undefined, node: ts.Node) => {
    const symbol = name && checker.getSymbolAtLocation(name);
    if (symbol) whole.set(symbol, node);
  };
  const classAtDefinition = (cls: ts.ClassLikeDeclaration) => {
    regions.push(...(cls.heritageClauses ?? []), ...(ts.getDecorators(cls) ?? []));
    for (const member of cls.members) {
      const isStatic = ts
        .getModifiers(member as ts.HasModifiers)
        ?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      if (
        ts.isClassStaticBlockDeclaration(member) ||
        (isStatic && ts.isPropertyDeclaration(member))
      )
        regions.push(member);
      else deferred.add(member);
      if (ts.canHaveDecorators(member)) regions.push(...(ts.getDecorators(member) ?? []));
      if (member.name && ts.isComputedPropertyName(member.name)) regions.push(member.name);
    }
  };
  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && !statement.moduleSpecifier) ||
      (ts.isModuleDeclaration(statement) &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
    )
      continue;
    if (ts.isFunctionDeclaration(statement)) {
      deferred.add(statement);
      declare(statement.name, statement);
    } else if (ts.isClassDeclaration(statement)) {
      classAtDefinition(statement);
      declare(statement.name, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer;
        if (!init) continue;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          deferred.add(init);
          declare(decl.name, init);
        } else if (ts.isClassExpression(init)) {
          classAtDefinition(init);
          declare(decl.name, init);
        } else {
          regions.push(init);
        }
      }
    } else {
      regions.push(statement);
    }
  }
  const out: { node: ts.Node; stop: ((n: ts.Node) => boolean) | undefined }[] = [];
  const queued = new Set<ts.Node>();
  const pending = regions.map((node) => ({ node, stop: (n: ts.Node) => deferred.has(n) }) as const);
  const queue: { node: ts.Node; stop: ((n: ts.Node) => boolean) | undefined }[] = [...pending];
  for (let item = queue.pop(); item; item = queue.pop()) {
    if (queued.has(item.node)) continue;
    queued.add(item.node);
    out.push(item);
    forEachValueRef(
      item.node,
      (id) => {
        const symbol = symbolOfRef(checker, id);
        const target = symbol && whole.get(symbol);
        if (target && !queued.has(target)) queue.push({ node: target, stop: undefined });
      },
      item.stop,
    );
  }
  return out;
}

/** An import whose target has no value meaning (an interface or type alias). */
function isTypeOnlyImport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return false;
  const target = checker.getAliasedSymbol(symbol);
  return target !== symbol && (target.flags & ts.SymbolFlags.Value) === 0 && target.flags !== 0;
}

/**
 * The module-level statements `declarations` live in, plus the ones they use, transitively
 * (imports excluded: their safety is decided where they're used).
 */
function reachedStatements(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  declarations: readonly ts.Declaration[],
): ts.Statement[] {
  const topLevel = (node: ts.Node): ts.Statement | undefined => {
    let current: ts.Node | undefined = node;
    while (current && current.parent !== sf) current = current.parent;
    return current && !ts.isImportDeclaration(current) ? (current as ts.Statement) : undefined;
  };
  const out = new Set<ts.Statement>();
  const pending = declarations.flatMap((d) => topLevel(d) ?? []);
  for (let statement = pending.pop(); statement; statement = pending.pop()) {
    if (out.has(statement)) continue;
    out.add(statement);
    forEachValueRef(statement, (id) => {
      const symbol = symbolOfRef(checker, id);
      if (!symbol || symbol.flags & ts.SymbolFlags.Alias) return;
      for (const decl of symbol.declarations ?? []) {
        if (decl.getSourceFile() !== sf) continue;
        const top = topLevel(decl);
        if (top && !out.has(top)) pending.push(top);
      }
    });
  }
  return [...out].sort((a, b) => a.getStart(sf) - b.getStart(sf));
}

/** Event handlers, refs or class components, which only work on the client. */
function renderProblem(node: ts.Node, rel: string): SafetyResult | undefined {
  const sf = node.getSourceFile();
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
  visit(node);
  return reason ? { safe: false, reason } : undefined;
}
