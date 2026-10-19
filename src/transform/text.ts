import { ts } from "ts-morph";

export type CodeStyle = { quote: '"' | "'"; semi: boolean; indent: string };

/** Infers quote style, semicolons and indentation unit from the original file. */
export function detectStyle(sf: ts.SourceFile): CodeStyle {
  let quote: '"' | "'" = '"';
  let semi = true;
  const first = sf.statements.find((s) => ts.isImportDeclaration(s) || ts.isExpressionStatement(s));
  if (first) {
    const text = first.getText(sf);
    semi = text.trimEnd().endsWith(";");
    const literal = ts.isImportDeclaration(first)
      ? first.moduleSpecifier
      : (first as ts.ExpressionStatement).expression;
    const raw = literal.getText(sf);
    if (raw.startsWith("'")) quote = "'";
  }
  // The indentation unit is the smallest indentation used by any line.
  let indent = "  ";
  let smallest = Number.POSITIVE_INFINITY;
  for (const match of sf.text.matchAll(/\n([ \t]+)\S/g)) {
    const ws = match[1] ?? "";
    if (ws.startsWith("\t")) {
      indent = "\t";
      break;
    }
    if (ws.length < smallest) {
      smallest = ws.length;
      indent = " ".repeat(ws.length);
    }
  }
  return { quote, semi, indent };
}

export function lineStartOf(text: string, pos: number): number {
  const i = text.lastIndexOf("\n", pos - 1);
  return i === -1 ? 0 : i + 1;
}

export function lineEndOf(text: string, pos: number): number {
  const i = text.indexOf("\n", pos);
  return i === -1 ? text.length : i;
}

export function indentationOfLine(text: string, pos: number): string {
  const start = lineStartOf(text, pos);
  const match = /^[ \t]*/.exec(text.slice(start));
  return match?.[0] ?? "";
}

/** True if the node contains a string or template literal that spans lines (re-indenting would change it). */
export function hasMultilineLiteral(node: ts.Node, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isTemplateLiteral(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      n.getText(sf).includes("\n")
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Re-indents lines 2..n of `text` from `fromIndent` to `toIndent` (first line is placed by the caller). */
export function reindent(text: string, fromIndent: string, toIndent: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      if (line.trim() === "") return "";
      if (line.startsWith(fromIndent)) return toIndent + line.slice(fromIndent.length);
      return toIndent + line.trimStart();
    })
    .join("\n");
}

/**
 * The range covering a statement plus its own-line leading comments, extended to whole lines
 * when the statement sits alone on its lines.
 */
export function statementLineRange(
  sf: ts.SourceFile,
  node: ts.Node,
): { start: number; end: number; whole: boolean } {
  const text = sf.text;
  let start = node.getStart(sf);
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  for (const comment of comments) {
    const before = text.slice(lineStartOf(text, comment.pos), comment.pos);
    if (before.trim() === "") {
      start = Math.min(start, comment.pos);
      break;
    }
  }
  const end = node.getEnd();
  const lineStart = lineStartOf(text, start);
  const lineEnd = lineEndOf(text, end);
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (before.trim() === "" && after.trim() === "") {
    return { start: lineStart, end: Math.min(text.length, lineEnd + 1), whole: true };
  }
  return { start, end, whole: false };
}
