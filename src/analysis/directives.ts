import { ts } from "ts-morph";

export type Directive = "use client" | "use server";

type DirectiveInfo = {
  directive: Directive | undefined;
  /** The directive statement itself, when present. */
  statement: ts.ExpressionStatement | undefined;
};

/** Reads the directive prologue (leading string-literal statements) of a module. */
export function getModuleDirective(sf: ts.SourceFile): DirectiveInfo {
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    const text = statement.expression.text;
    if (text === "use client" || text === "use server") return { directive: text, statement };
  }
  return { directive: undefined, statement: undefined };
}

/** True if a function body starts with a "use server" directive (an inline Server Action). */
export function hasUseServerBody(fn: ts.FunctionLikeDeclaration): boolean {
  const body = fn.body;
  if (!body || !ts.isBlock(body)) return false;
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

const IGNORE_RE = /^auto-server-split-ignore(?![\w-])[\s:,-]*(.*)$/s;

/** A comment's words, without the comment markers and the `*` that starts each JSDoc line. */
function commentText(comment: string): string {
  return comment
    .replace(/^\/\/|^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*?/, ""))
    .join(" ")
    .trim();
}

/**
 * An `auto-server-split-ignore` comment in the file header (before the first statement that isn't
 * a directive, or on a directive's line), with the reason written after it, if any:
 * `// auto-server-split-ignore: keeps the chart out of the server bundle`.
 */
export function findIgnoreComment(sf: ts.SourceFile): { reason: string; pos: number } | undefined {
  const text = sf.text;
  const ranges: ts.CommentRange[] = [];
  for (const statement of sf.statements) {
    ranges.push(...(ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []));
    const prologue =
      ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
    if (!prologue) break;
    ranges.push(...(ts.getTrailingCommentRanges(text, statement.getEnd()) ?? []));
  }
  if (sf.statements.length === 0) ranges.push(...(ts.getLeadingCommentRanges(text, 0) ?? []));
  for (const range of ranges) {
    const match = IGNORE_RE.exec(commentText(text.slice(range.pos, range.end)));
    if (match) return { reason: (match[1] ?? "").replace(/\s+/g, " ").trim(), pos: range.pos };
  }
  return undefined;
}
