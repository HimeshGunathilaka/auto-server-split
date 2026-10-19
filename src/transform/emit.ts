import MagicString from "magic-string";
import { ts } from "ts-morph";
import type { FileShape, ModuleDecl } from "../analysis/components.js";
import type { AnalysisContext } from "../analysis/context.js";
import { locOf } from "../analysis/context.js";
import { getModuleDirective } from "../analysis/directives.js";
import type { ImportBinding, ImportTable } from "../analysis/importTable.js";
import type { ComponentPlan, IslandPlan, Unit } from "../analysis/islands.js";
import { islandBaseName } from "../analysis/islands.js";
import {
  containsRange,
  forEachIdentifier,
  forEachValueRef,
  symbolOfRef,
} from "../analysis/refs.js";
import type { Outcome } from "../analysis/skip.js";
import { ok, skip } from "../analysis/skip.js";
import type { CodeStyle } from "./text.js";
import {
  detectStyle,
  hasMultilineLiteral,
  indentationOfLine,
  lineEndOf,
  lineStartOf,
  reindent,
  statementLineRange,
} from "./text.js";
import { TypeRefCollector } from "./typeRefs.js";

export type EmitInput = {
  ctx: AnalysisContext;
  shape: FileShape;
  imports: ImportTable;
  plans: ComponentPlan[];
  /** Specifier used by the server file to import the islands, e.g. "./PostCard.client". */
  islandSpecifier: string;
  /** Specifier used by the island file to import exported types from the original, e.g. "./PostCard". */
  originalSpecifier: string;
  /** Rewrites a relative specifier of the original file so it works from the island file. */
  rebaseSpecifier: (specifier: string) => string;
};

export type EmitOutput = { serverText: string; islandText: string; islands: IslandPlan[] };

type Range = { start: number; end: number };

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

const inAny = (ranges: Range[], pos: number) => ranges.some((r) => pos >= r.start && pos < r.end);

/** Assigns deterministic island names: <Component><PascalCase root tag>, then 2, 3... on collision. */
function assignNames(plans: ComponentPlan[], taken: Set<string>): void {
  for (const plan of plans) {
    for (const island of plan.islands) {
      const base = islandBaseName(plan.component.name, island.rootTag);
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
      taken.add(name);
      island.name = name;
    }
  }
}

function importClauseText(
  entries: { binding: ImportBinding; typeOnly: boolean }[],
  allTypeOnly: boolean,
): string {
  const def = entries.find((e) => e.binding.imported === "default");
  const ns = entries.find((e) => e.binding.imported === "*");
  const named = entries.filter(
    (e) => e.binding.imported !== "default" && e.binding.imported !== "*",
  );
  const parts: string[] = [];
  if (def) parts.push(def.binding.local);
  if (ns) parts.push(`* as ${ns.binding.local}`);
  if (named.length > 0) {
    const items = named.map((e) => {
      const prefix = e.typeOnly && !allTypeOnly ? "type " : "";
      const name =
        e.binding.imported === e.binding.local
          ? e.binding.local
          : `${e.binding.imported} as ${e.binding.local}`;
      return prefix + name;
    });
    parts.push(`{ ${items.join(", ")} }`);
  }
  return parts.join(", ");
}

function importStatement(
  decl: ts.ImportDeclaration,
  sf: ts.SourceFile,
  entries: { binding: ImportBinding; typeOnly: boolean }[],
  style: CodeStyle,
  specifierText: string,
): string[] {
  const allTypeOnly = entries.every((e) => e.typeOnly);
  const attributes = decl.attributes ? ` ${decl.attributes.getText(sf)}` : "";
  const semi = style.semi ? ";" : "";
  const def = entries.find((e) => e.binding.imported === "default");
  const rest = entries.filter((e) => e !== def);
  // `import type X, { Y }` is invalid; split default and named when both are type-only.
  if (allTypeOnly && def && rest.length > 0) {
    return [
      `import type ${def.binding.local} from ${specifierText}${attributes}${semi}`,
      `import type ${importClauseText(rest, true)} from ${specifierText}${attributes}${semi}`,
    ];
  }
  return [
    `import ${allTypeOnly ? "type " : ""}${importClauseText(entries, allTypeOnly)} from ${specifierText}${attributes}${semi}`,
  ];
}

/** Produces the rewritten server file and the generated island file. */
export function emitSplit(input: EmitInput): Outcome<EmitOutput> {
  const { ctx, shape, imports, plans } = input;
  const { sf, checker } = ctx;
  const text = sf.text;
  const style = detectStyle(sf);
  const q = style.quote;
  const semi = style.semi ? ";" : "";

  // ---- names ----------------------------------------------------------------------------------
  const taken = new Set<string>();
  for (const b of imports.bindings) taken.add(b.local);
  for (const d of shape.moduleDecls) d.names.forEach((n) => taken.add(n));
  for (const c of shape.components) taken.add(c.name);
  assignNames(plans, taken);
  const islands = plans.flatMap((p) => p.islands);

  // ---- island file -----------------------------------------------------------------------------
  const islandContent: ts.Node[] = islands.flatMap((i) => [
    i.root.node,
    ...i.units.map((u) => u.node),
  ]);
  const collector = new TypeRefCollector(sf, checker, imports, shape.moduleDecls, islandContent);
  const valueImports = new Set<ImportBinding>();
  const copiedDecls = new Set<ModuleDecl>();
  for (const island of islands) {
    island.valueImports.forEach((b) => valueImports.add(b));
    island.moduleDecls.forEach((d) => copiedDecls.add(d));
  }
  // Values referenced by copied module declarations.
  const declQueue = [...copiedDecls];
  while (declQueue.length > 0) {
    const decl = declQueue.pop() as ModuleDecl;
    let failure: string | undefined;
    forEachValueRef(decl.statement, (id) => {
      const symbol = symbolOfRef(checker, id);
      if (!symbol) return;
      const binding = imports.bySymbol.get(symbol);
      if (binding) {
        valueImports.add(binding);
        return;
      }
      const d = symbol.declarations?.[0];
      if (!d || d.getSourceFile() !== sf || containsRange(decl.statement, d)) return;
      const other = shape.moduleDecls.find((m) => containsRange(m.statement, d));
      if (other && !copiedDecls.has(other)) {
        copiedDecls.add(other);
        declQueue.push(other);
      } else if (!other) {
        failure = `copied helper refers to \`${id.text}\`, which can't be moved`;
      }
    });
    if (failure) return skip("unsupported-pattern", failure, locOf(ctx, decl.statement));
  }

  for (const node of islandContent) {
    const failure = collector.collectFromNode(node);
    if (failure)
      return skip(
        "unsupported-pattern",
        failure.message,
        failure.node ? locOf(ctx, failure.node) : undefined,
      );
  }
  for (const decl of copiedDecls) {
    const failure = collector.collectFromNode(decl.statement);
    if (failure) return skip("unsupported-pattern", failure.message, locOf(ctx, decl.statement));
  }

  const signatures = new Map<IslandPlan, string>();
  for (const island of islands) {
    if (island.props.length === 0) {
      signatures.set(island, "");
      continue;
    }
    const names = island.props.map((p) => p.name).join(", ");
    if (ctx.isJs) {
      signatures.set(island, `{ ${names} }`);
      continue;
    }
    const members: string[] = [];
    for (const prop of island.props) {
      const printed = checker.typeToString(
        prop.type,
        island.root.node,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
      const result = collector.collectFromPrinted(printed, island.root.node);
      if ("message" in result)
        return skip(
          "unsupported-pattern",
          `prop \`${prop.name}\`: ${result.message}`,
          locOf(ctx, prop.refNode),
        );
      members.push(`${prop.name}: ${result.text}`);
    }
    signatures.set(island, `{ ${names} }: { ${members.join("; ")} }`);
  }

  const allCopied = new Set<ModuleDecl>([...copiedDecls]);
  for (const decl of collector.deps.moduleDecls) if (!decl.exported) allCopied.add(decl);
  const exportedTypeImports = [...collector.deps.moduleDecls]
    .filter((d) => d.exported)
    .flatMap((d) => d.names);

  const islandLines: string[] = [];
  const directiveQuote = q;
  islandLines.push(`${directiveQuote}use client${directiveQuote}${semi}`);
  for (const decl of imports.declarations) {
    const entries: { binding: ImportBinding; typeOnly: boolean }[] = [];
    for (const binding of imports.bindings) {
      if (binding.declaration !== decl) continue;
      const usedAsValue = valueImports.has(binding);
      const usedAsType = collector.deps.imports.has(binding);
      if (!usedAsValue && !usedAsType) continue;
      entries.push({ binding, typeOnly: binding.typeOnly || !usedAsValue });
    }
    if (entries.length === 0) continue;
    const spec = decl.moduleSpecifier as ts.StringLiteral;
    const rebased = input.rebaseSpecifier(spec.text);
    const specText = rebased === spec.text ? spec.getText(sf) : `${q}${rebased}${q}`;
    const all = imports.bindings.filter((b) => b.declaration === decl);
    const sameAsOriginal =
      rebased === spec.text &&
      entries.length === all.length &&
      entries.every((e) => e.typeOnly === e.binding.typeOnly);
    if (sameAsOriginal) islandLines.push(decl.getText(sf));
    else islandLines.push(...importStatement(decl, sf, entries, style, specText));
  }
  if (exportedTypeImports.length > 0) {
    islandLines.push(
      `import type { ${exportedTypeImports.join(", ")} } from ${q}${input.originalSpecifier}${q}${semi}`,
    );
  }
  for (const [spec, names] of collector.deps.synthetic) {
    islandLines.push(`import type { ${[...names].join(", ")} } from ${q}${spec}${q}${semi}`);
  }

  const blocks: string[] = [islandLines.join("\n")];
  for (const decl of shape.moduleDecls) {
    if (!allCopied.has(decl)) continue;
    const range = statementLineRange(sf, decl.statement);
    blocks.push(text.slice(range.start, decl.statement.getEnd()).replace(/^\s*\n/, ""));
  }

  for (const island of islands) {
    blocks.push(renderIsland(island, signatures.get(island) ?? "", sf, style));
  }
  const islandText = `${blocks.join("\n\n")}\n`;

  // ---- server file -------------------------------------------------------------------------------
  const ms = new MagicString(text);
  const removed: Range[] = [];

  const directive = getModuleDirective(sf).statement;
  if (directive) {
    let end = directive.getEnd();
    while (end < text.length && /\s/.test(text[end] ?? "")) end++;
    removed.push({ start: directive.getStart(sf), end });
  }

  // Body statements that leave the server component.
  const unitRanges: Range[] = [];
  for (const plan of plans) {
    for (const unit of plan.removedUnits) unitRanges.push(statementLineRange(sf, unit.node));
  }
  for (const r of mergeRanges(unitRanges)) removed.push(collapseBlankLines(text, r));

  // Module declarations that move entirely (client-only helpers) or are no longer used on the server.
  const replacedRoots: Range[] = islands.map((i) => ({
    start: i.root.node.getStart(sf),
    end: i.root.node.getEnd(),
  }));
  const moduleRemovals = new Set<ModuleDecl>();
  for (const plan of plans) plan.movedModuleDecls.forEach((d) => moduleRemovals.add(d));
  const baseRemoved = () => [
    ...removed,
    ...replacedRoots,
    ...[...moduleRemovals].map((d) => statementLineRange(sf, d.statement)),
  ];
  for (let changed = true; changed;) {
    changed = false;
    for (const decl of allCopied) {
      if (moduleRemovals.has(decl) || decl.exported) continue;
      if (!isReferencedOutside(decl, sf, checker, baseRemoved())) {
        moduleRemovals.add(decl);
        changed = true;
      }
    }
  }
  for (const decl of moduleRemovals) {
    if (isReferencedOutside(decl, sf, checker, baseRemoved())) {
      return skip(
        "unsupported-pattern",
        `client-only helper ${decl.names.join(", ")} is still used by the server part`,
        locOf(ctx, decl.statement),
      );
    }
    removed.push(collapseBlankLines(text, statementLineRange(sf, decl.statement)));
  }

  // Imports: keep only what the server part still references.
  const allRemoved = [...removed, ...replacedRoots];
  const keyRanges: Range[] = islands.flatMap((i) =>
    i.keyAttr ? [{ start: i.keyAttr.getStart(sf), end: i.keyAttr.getEnd() }] : [],
  );
  const remainingUse = new Map<ImportBinding, { value: boolean; type: boolean }>();
  forEachIdentifier(sf, (id) => {
    const pos = id.getStart(sf);
    if (inAny(allRemoved, pos) && !inAny(keyRanges, pos)) return;
    const symbol = symbolOfRef(checker, id);
    const binding = symbol ? imports.bySymbol.get(symbol) : undefined;
    if (!binding) return;
    if (containsRange(binding.declaration, id)) return;
    const use = remainingUse.get(binding) ?? { value: false, type: false };
    if (isInTypePosition(id)) use.type = true;
    else use.value = true;
    remainingUse.set(binding, use);
  });

  let lastKeptImport: ts.ImportDeclaration | undefined;
  for (const decl of imports.declarations) {
    const all = imports.bindings.filter((b) => b.declaration === decl);
    if (!decl.importClause) {
      lastKeptImport = decl; // side-effect imports (CSS) stay with the server component
      continue;
    }
    const kept = all.filter((b) => remainingUse.has(b));
    const range = statementLineRange(sf, decl);
    if (kept.length === 0) {
      removed.push(range);
      ms.remove(range.start, range.end);
      continue;
    }
    lastKeptImport = decl;
    const valueUsed = kept.some((b) => remainingUse.get(b)?.value && !b.typeOnly);
    const moduleIsNeutral = kept.every((b) => isNeutralModule(b));
    const needsTypeOnly = !valueUsed && !decl.importClause.isTypeOnly && !moduleIsNeutral;
    if (kept.length === all.length && !needsTypeOnly) continue;
    const entries = kept.map((b) => ({ binding: b, typeOnly: b.typeOnly || needsTypeOnly }));
    const spec = (decl.moduleSpecifier as ts.StringLiteral).getText(sf);
    ms.overwrite(
      decl.getStart(sf),
      decl.getEnd(),
      importStatement(decl, sf, entries, style, spec).join("\n"),
    );
  }

  if (directive) ms.remove(directive.getStart(sf), removed[0]?.end ?? directive.getEnd());
  for (const r of mergeRanges(unitRanges)) {
    const collapsed = collapseBlankLines(text, r);
    ms.remove(collapsed.start, collapsed.end);
  }
  for (const decl of moduleRemovals) {
    const r = collapseBlankLines(text, statementLineRange(sf, decl.statement));
    ms.remove(r.start, r.end);
  }

  for (const island of islands) {
    const attrs: string[] = [];
    if (island.keyAttr) attrs.push(island.keyAttr.getText(sf));
    for (const prop of island.props) attrs.push(`${prop.name}={${prop.name}}`);
    const usage = `<${island.name}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""} />`;
    ms.overwrite(island.root.node.getStart(sf), island.root.node.getEnd(), usage);
  }

  const importLine = `import { ${islands.map((i) => i.name).join(", ")} } from ${q}${input.islandSpecifier}${q}${semi}`;
  const firstImport = imports.declarations[0];
  if (lastKeptImport) ms.appendLeft(lastKeptImport.getEnd(), `\n${importLine}`);
  else if (firstImport) {
    // Every import was removed: the island import takes the place of the first one.
    ms.prependRight(statementLineRange(sf, firstImport).start, `${importLine}\n`);
  } else {
    const firstKept = sf.statements.find((s) => s !== directive && !inAny(removed, s.getStart(sf)));
    const at = firstKept ? lineStartOf(text, firstKept.getStart(sf)) : text.length;
    ms.prependRight(at, `${importLine}\n\n`);
  }

  return ok({ serverText: ms.toString(), islandText, islands });
}

function isNeutralModule(binding: ImportBinding): boolean {
  if (binding.module.kind === "project") return binding.module.directive !== "use client";
  return [
    "neutral",
    "server-safe-list",
    "json",
    "asset",
    "css-module",
    "stylesheet",
    "react",
    "builtin",
    "server-only-marker",
  ].includes(binding.module.info.kind);
}

function isInTypePosition(id: ts.Identifier): boolean {
  let node: ts.Node = id;
  while (node.parent) {
    if (ts.isTypeNode(node.parent) && !ts.isExpressionWithTypeArguments(node.parent)) return true;
    if (ts.isTypeAliasDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent))
      return true;
    if (ts.isExpression(node.parent) || ts.isStatement(node.parent)) return false;
    node = node.parent;
  }
  return false;
}

function isReferencedOutside(
  decl: ModuleDecl,
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  removed: Range[],
): boolean {
  const symbols = new Set<ts.Symbol>();
  for (const name of decl.names) {
    const nameNode = (decl.statement as ts.Statement & { name?: ts.Identifier }).name;
    if (nameNode && ts.isIdentifier(nameNode)) {
      const s = checker.getSymbolAtLocation(nameNode);
      if (s) symbols.add(s);
    }
    if (ts.isVariableStatement(decl.statement)) {
      for (const d of decl.statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) {
          const s = checker.getSymbolAtLocation(d.name);
          if (s) symbols.add(s);
        }
      }
    }
  }
  let found = false;
  forEachIdentifier(sf, (id) => {
    if (found) return;
    if (containsRange(decl.statement, id)) return;
    if (inAny(removed, id.getStart(sf))) return;
    const symbol = symbolOfRef(checker, id);
    if (symbol && symbols.has(symbol)) found = true;
  });
  return found;
}

/** Extends a whole-line removal so it doesn't leave a blank line right after `{` or a double blank line. */
function collapseBlankLines(text: string, range: Range): Range {
  const { start } = range;
  let { end } = range;
  const prevLineEnd = start - 1;
  const prevLine = prevLineEnd >= 0 ? text.slice(lineStartOf(text, prevLineEnd), prevLineEnd) : "";
  const isBlankAt = (pos: number) =>
    pos < text.length && text.slice(pos, lineEndOf(text, pos)).trim() === "";
  if (start > 0 && text[start - 1] === "\n") {
    if (prevLine.trimEnd().endsWith("{") || prevLine.trimEnd().endsWith("(")) {
      while (end < text.length && isBlankAt(end) && text[lineEndOf(text, end)] === "\n")
        end = lineEndOf(text, end) + 1;
    } else if (prevLine.trim() === "" && isBlankAt(end) && text[lineEndOf(text, end)] === "\n") {
      end = lineEndOf(text, end) + 1;
    }
  }
  return { start, end };
}

function renderIsland(
  island: IslandPlan,
  signature: string,
  sf: ts.SourceFile,
  style: CodeStyle,
): string {
  const text = sf.text;
  const semi = style.semi ? ";" : "";
  const ind = style.indent;
  const lines: string[] = [`export function ${island.name}(${signature}) {`];
  for (const unit of island.units) lines.push(renderUnit(unit, sf, ind));

  const root = island.root.node;
  const rootStart = root.getStart(sf);
  const ms = new MagicString(text);
  if (island.keyAttr) {
    let start = island.keyAttr.getStart(sf);
    while (start > 0 && /[ \t]/.test(text[start - 1] ?? "")) start--;
    ms.remove(start, island.keyAttr.getEnd());
  }
  let rootText = ms.slice(rootStart, root.getEnd());
  const multiline = rootText.includes("\n");
  if (!multiline) {
    lines.push(`${ind}return ${rootText}${semi}`);
  } else {
    if (!hasMultilineLiteral(root, sf))
      rootText = reindent(rootText, indentationOfLine(text, rootStart), ind + ind);
    lines.push(`${ind}return (`, `${ind}${ind}${rootText}`, `${ind})${semi}`);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderUnit(unit: Unit, sf: ts.SourceFile, ind: string): string {
  const text = sf.text;
  const range = statementLineRange(sf, unit.node);
  const start = range.whole ? range.start : unit.node.getStart(sf);
  let chunk = text.slice(start, unit.node.getEnd());
  const lineIndent = indentationOfLine(text, unit.node.getStart(sf));
  chunk = chunk.replace(/^[ \t]*/, "");
  if (!hasMultilineLiteral(unit.node, sf)) chunk = reindent(chunk, lineIndent, ind);
  return `${ind}${chunk}`;
}
