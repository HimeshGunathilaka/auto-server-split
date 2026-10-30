import path from "node:path";
import { ts } from "ts-morph";
import { getModuleDirective } from "../analysis/directives.js";
import type { FrameworkAdapter } from "../analysis/framework.js";
import { buildImportTable } from "../analysis/importTable.js";
import type { ModuleSafety } from "../analysis/moduleSafety.js";
import type { SafetyRules } from "../analysis/rules.js";
import { isIntrinsicTagName, stripParens } from "../analysis/refs.js";
import { checkSerializable, isCallableType } from "../analysis/serializable.js";
import type { Outcome } from "../analysis/skip.js";
import { ok, skip } from "../analysis/skip.js";
import { FileFacts } from "../analysis/taint.js";
import type { LoadedProject } from "../project/loadProject.js";
import { setSourceText } from "../project/loadProject.js";
import type { ModuleGraph } from "../project/moduleGraph.js";
import type { PackageClassifier } from "../project/packages.js";

type SelfCheckInput = {
  loaded: LoadedProject;
  graph: ModuleGraph;
  framework: FrameworkAdapter;
  classifier: PackageClassifier;
  moduleSafety: ModuleSafety;
  serverSafeHooks: ReadonlySet<string>;
  rules?: SafetyRules;
  file: string;
  serverText: string;
  /** The generated island file; undefined when only the `"use client"` directive is removed. */
  island: { file: string; specifier: string; text: string } | undefined;
  /** Files whose diagnostics must not change (importers of `file`). */
  importers: string[];
  /** Component props that importers fill with Server Actions; they may cross the boundary. */
  serverActionProps?: ReadonlySet<string>;
  isJs: boolean;
};

type DiagKey = string;

function diagnosticsOf(
  program: ts.Program,
  sf: ts.SourceFile,
  bucket: string,
): Map<DiagKey, number> {
  const out = new Map<DiagKey, number>();
  const all = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  for (const d of all) {
    const key = `${bucket}|TS${d.code}|${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

function merge(into: Map<DiagKey, number>, from: Map<DiagKey, number>): void {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
}

/**
 * Re-verifies the generated code in memory before anything is reported or written:
 * both files parse, typechecking finds no new diagnostics, the rewritten file has no client-only
 * code left, every island prop is serializable, and the island file has no server-only imports.
 */
export function selfCheck(input: SelfCheckInput): Outcome<void> {
  const { loaded, file, island } = input;
  const project = loaded.project;
  const original = project.getSourceFile(file);
  if (!original) return skip("self-check-failed", "the original file is not in the project");
  const originalText = original.getFullText();

  const before = new Map<DiagKey, number>();
  {
    const program = project.getProgram().compilerObject;
    const sf = program.getSourceFile(file);
    if (sf) merge(before, diagnosticsOf(program, sf, "self"));
    for (const importer of input.importers) {
      const isf = program.getSourceFile(importer);
      if (isf) merge(before, diagnosticsOf(program, isf, importer));
    }
  }

  let islandWrapper: ReturnType<typeof project.createSourceFile> | undefined;
  try {
    setSourceText(original, input.serverText);
    if (island)
      islandWrapper = project.createSourceFile(island.file, island.text, { overwrite: false });
    const program = project.getProgram().compilerObject;
    const checker = program.getTypeChecker();
    const serverSf = program.getSourceFile(file);
    const islandSf = island ? program.getSourceFile(island.file) : undefined;
    if (!serverSf || (island && !islandSf))
      return skip("self-check-failed", "generated files are missing from the program");
    const outputs = islandSf ? [serverSf, islandSf] : [serverSf];

    // 1. Both files parse.
    for (const sf of outputs) {
      const syntax = program.getSyntacticDiagnostics(sf);
      const first = syntax[0];
      if (first) {
        return skip(
          "self-check-failed",
          `${path.basename(sf.fileName)} doesn't parse: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
        );
      }
    }

    // 2. No new type errors.
    const after = new Map<DiagKey, number>();
    for (const sf of outputs) merge(after, diagnosticsOf(program, sf, "self"));
    for (const importer of input.importers) {
      const isf = program.getSourceFile(importer);
      if (isf) merge(after, diagnosticsOf(program, isf, importer));
    }
    const added: string[] = [];
    for (const [key, count] of after) {
      if (count > (before.get(key) ?? 0)) added.push(key.split("|").slice(1).join(": "));
    }
    if (added.length > 0) {
      return skip(
        "self-check-failed",
        `typechecking the output found new errors: ${added.slice(0, 3).join("; ")}`,
      );
    }

    // 3. The rewritten file is a Server Component with no client-only code left.
    if (getModuleDirective(serverSf).directive === "use client") {
      return skip("self-check-failed", 'the rewritten file still starts with "use client"');
    }
    const imports = buildImportTable(serverSf, checker, input.graph);
    const facts = new FileFacts(
      serverSf,
      checker,
      imports,
      input.framework,
      input.moduleSafety.check,
      input.serverSafeHooks,
      input.rules,
    );
    const islandSymbols = new Set(
      imports.bindings.filter((b) => b.specifier === island?.specifier).map((b) => b.symbol),
    );
    for (const marker of facts.scanMarkers(serverSf)) {
      if (
        marker.kind === "client-import" &&
        islandSymbols.size > 0 &&
        isIslandTag(marker.node, checker, islandSymbols)
      )
        continue;
      return skip(
        "self-check-failed",
        `the rewritten file still uses client-only code (${marker.detail})`,
      );
    }

    // 4. Every element that crosses into client code gets serializable props.
    let problem: string | undefined;
    const visit = (n: ts.Node): void => {
      if (problem) return;
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const intrinsic = isIntrinsicTagName(n.tagName);
        const crossesBoundary =
          !intrinsic && isClientReferenceTag(n.tagName, facts, islandSymbols, checker);
        for (const attr of n.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attr)) {
            if (
              crossesBoundary &&
              !checkSerializable(checker, checker.getTypeAtLocation(attr.expression), {
                primitivesOnly: input.isJs,
              }).ok
            ) {
              problem = `spread props on <${n.tagName.getText(serverSf)}> are not serializable`;
            }
            continue;
          }
          const name = attr.name.getText(serverSf);
          // Event/ref props only matter on DOM elements; component props are checked by value below.
          if (intrinsic && (/^on[A-Z]/.test(name) || name === "ref")) {
            problem = `<${n.tagName.getText(serverSf)}> still has ${name}`;
            return;
          }
          const init = attr.initializer;
          if (!init || !ts.isJsxExpression(init) || !init.expression) continue;
          const type = checker.getTypeAtLocation(init.expression);
          const action = isServerActionExpr(init.expression, facts, input.serverActionProps);
          if (isCallableType(type) && !action) {
            problem = `<${n.tagName.getText(serverSf)}> receives a function in ${name}`;
            return;
          }
          if (crossesBoundary && !action) {
            const verdict = checkSerializable(checker, type, { primitivesOnly: input.isJs });
            if (!verdict.ok) {
              problem = `prop ${name} of <${n.tagName.getText(serverSf)}> ${verdict.reason}`;
              return;
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(serverSf);
    if (problem) return skip("self-check-failed", problem);

    // 5. The island file imports nothing server-only.
    if (island && islandSf) {
      for (const statement of islandSf.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        if (statement.importClause?.isTypeOnly) continue;
        const spec = statement.moduleSpecifier.text;
        const resolved = ts.resolveModuleName(
          spec,
          island.file,
          { ...loaded.compilerOptions, allowJs: true },
          ts.sys,
        ).resolvedModule;
        // Project modules were already imported by the original client file, so they are client-safe.
        if (
          resolved &&
          !resolved.isExternalLibraryImport &&
          !resolved.resolvedFileName.includes("/node_modules/")
        )
          continue;
        const info = input.classifier.classify(spec, island.file);
        if (info.kind === "builtin" || info.kind === "server-only-marker") {
          return skip(
            "self-check-failed",
            `the island file imports the server-only module ${spec}`,
          );
        }
        if (info.kind === "framework") {
          const rule = input.framework.classifyModule(spec);
          if (rule?.kind === "per-name") {
            const names = namedImports(statement);
            if (names.some((n) => rule.classify(n) === "server-only")) {
              return skip(
                "self-check-failed",
                `the island file imports the server-only module ${spec}`,
              );
            }
          }
        }
      }
    }

    return ok(undefined);
  } finally {
    setSourceText(original, originalText);
    if (islandWrapper) project.removeSourceFile(islandWrapper);
  }
}

function namedImports(decl: ts.ImportDeclaration): string[] {
  const clause = decl.importClause;
  if (!clause) return [];
  const out: string[] = [];
  if (clause.name) out.push("default");
  const b = clause.namedBindings;
  if (b && ts.isNamedImports(b))
    for (const e of b.elements) out.push((e.propertyName ?? e.name).text);
  if (b && ts.isNamespaceImport(b)) out.push("*");
  return out;
}

function isIslandTag(
  node: ts.Node,
  checker: ts.TypeChecker,
  islandSymbols: Set<ts.Symbol>,
): boolean {
  if (!ts.isIdentifier(node)) return false;
  const symbol = checker.getSymbolAtLocation(node);
  return symbol !== undefined && islandSymbols.has(symbol);
}

function isClientReferenceTag(
  tag: ts.JsxTagNameExpression,
  facts: FileFacts,
  islandSymbols: Set<ts.Symbol>,
  checker: ts.TypeChecker,
): boolean {
  let head: ts.Node = tag;
  while (ts.isPropertyAccessExpression(head)) head = head.expression;
  if (!ts.isIdentifier(head)) return true;
  const symbol = checker.getSymbolAtLocation(head);
  if (symbol && islandSymbols.has(symbol)) return true;
  const info = facts.classifyRef(head);
  if (info.kind === "import") return info.usage.cls !== "neutral";
  return info.kind !== "file";
}

function isServerActionExpr(
  expr: ts.Expression,
  facts: FileFacts,
  serverActionProps: ReadonlySet<string> | undefined,
): boolean {
  const e = stripParens(expr);
  if (!ts.isIdentifier(e)) return false;
  const info = facts.classifyRef(e);
  if (info.kind === "import") return info.usage.cls === "server-action";
  if (info.kind === "file" && serverActionProps && ts.isBindingElement(info.declaration)) {
    const element = info.declaration;
    const propName = element.propertyName ?? element.name;
    const inParameter =
      ts.isObjectBindingPattern(element.parent) && ts.isParameter(element.parent.parent);
    return inParameter && ts.isIdentifier(propName) && serverActionProps.has(propName.text);
  }
  return false;
}
