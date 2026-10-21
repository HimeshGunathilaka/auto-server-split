import { ts } from "ts-morph";
import type { PickedProp } from "./mongoose.js";

/** Object types React serializes as more than their fields (or that aren't plain data at all). */
const isLibOrReactTypes = (f: string) =>
  /\/lib\.[a-z0-9.]*\.d\.ts$/.test(f) ||
  /\/@types\/(?:node|react)\//.test(f) ||
  /\/undici-types\//.test(f);

function isPlainObjectType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object) || type.isUnion()) return false;
  if (checker.isArrayType(type) || checker.isTupleType(type)) return false;
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false;
  if (checker.getIndexInfosOfType(type).length > 0) return false;
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return !(symbol?.declarations ?? []).some((d) => isLibOrReactTypes(d.getSourceFile().fileName));
}

/**
 * When the island only reads some fields of a plain-object prop (`post.date`), passes just those
 * fields: `post={{ date: post.date }}`, typed `{ date: string }`. The island's code is unchanged,
 * and the rest of the object (`post.body`) stays out of the server-to-client payload.
 *
 * Undefined, so the whole value is passed as before, when the island uses the object as a whole
 * (passes it on, spreads it, lists it as a hook dependency), uses optional chaining or element access
 * on it, writes to it, or reads every field anyway.
 */
export function pickReadFields(
  checker: ts.TypeChecker,
  name: string,
  type: ts.Type,
  refs: ts.Identifier[],
  printType: (type: ts.Type) => string,
): PickedProp | undefined {
  if (refs.length === 0 || !isPlainObjectType(checker, type)) return undefined;
  const read = new Set<string>();
  for (const ref of refs) {
    const access = ref.parent;
    if (
      !ts.isPropertyAccessExpression(access) ||
      access.expression !== ref ||
      access.questionDotToken ||
      !ts.isIdentifier(access.name) ||
      isWritten(access)
    )
      return undefined;
    if (!type.getProperty(access.name.text)) return undefined;
    read.add(access.name.text);
  }
  const all = checker.getPropertiesOfType(type);
  if (read.size >= all.length) return undefined;

  const exprs: string[] = [];
  const types: string[] = [];
  // In the type's own field order.
  for (const symbol of all) {
    const field = symbol.getName();
    if (!read.has(field)) continue;
    const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
    const fieldType = checker.getTypeOfSymbolAtLocation(symbol, refs[0] as ts.Node);
    exprs.push(`${field}: ${name}.${field}`);
    types.push(`${field}${optional ? "?" : ""}: ${printType(fieldType)}`);
  }
  return { serverExpr: `{ ${exprs.join(", ")} }`, typeText: `{ ${types.join("; ")} }` };
}

/** `obj.x = …`, `obj.x += …`, `obj.x++`, `delete obj.x`. */
function isWritten(access: ts.PropertyAccessExpression): boolean {
  let node: ts.Node = access;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return true;
  if (ts.isPostfixUnaryExpression(parent) || ts.isDeleteExpression(parent)) return true;
  return (
    ts.isPrefixUnaryExpression(parent) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  );
}
