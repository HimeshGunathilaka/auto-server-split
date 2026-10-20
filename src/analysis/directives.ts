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
