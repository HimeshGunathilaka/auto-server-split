import { ts } from "ts-morph";
import { checkSerializable } from "./serializable.js";

/**
 * Mongoose / BSON support (spec 5.5, opt-in with `mongoose.autoSerialize`). A prop whose type is a
 * Mongoose document or contains an ObjectId isn't serializable, but the island usually reads only a
 * few fields. We pass exactly those fields as a plain object built on the server, converting
 * ObjectIds with String() and keeping Dates as they are.
 */

const MONGO_TYPES_RE =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(bson|mongodb|mongoose)\//;

function declaredInMongoPackage(symbol: ts.Symbol | undefined): boolean {
  return (symbol?.declarations ?? []).some((d) => MONGO_TYPES_RE.test(d.getSourceFile().fileName));
}

export function isObjectIdType(type: ts.Type): boolean {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  return symbol?.getName() === "ObjectId" && declaredInMongoPackage(symbol);
}

/** True if the type is a Mongoose document or (transitively) contains an ObjectId. */
export function isMongooseLike(checker: ts.TypeChecker, type: ts.Type): boolean {
  const seen = new Set<ts.Type>();
  const visit = (t: ts.Type, depth: number): boolean => {
    if (depth > 6 || seen.has(t)) return false;
    seen.add(t);
    if (isObjectIdType(t)) return true;
    if (t.isUnionOrIntersection()) return t.types.some((m) => visit(m, depth + 1));
    if (!(t.flags & ts.TypeFlags.Object)) return false;
    const isDoc =
      t.getProperty("$isNew") !== undefined && declaredInMongoPackage(t.getProperty("$isNew"));
    if (isDoc) return true;
    if (checker.isArrayType(t))
      return checker.getTypeArguments(t as ts.TypeReference).some((a) => visit(a, depth + 1));
    for (const prop of checker.getPropertiesOfType(t).slice(0, 200)) {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      if (!decl || MONGO_TYPES_RE.test(decl.getSourceFile().fileName)) continue;
      if (visit(checker.getTypeOfSymbolAtLocation(prop, decl), depth + 1)) return true;
    }
    return false;
  };
  return visit(type, 0);
}

type Leaf = { kind: "leaf"; source: string; type: ts.Type; objectId: boolean; nullable: boolean };
type Branch = { kind: "branch"; fields: Map<string, Leaf | Branch> };

export type PickedProp = {
  /** Object literal evaluated on the server, e.g. `{ _id: String(post._id), title: post.title }`. */
  serverExpr: string;
  /** TypeScript type of that object, e.g. `{ _id: string; title: string }`. */
  typeText: string;
};

export type PickResult = { ok: true; value: PickedProp } | { ok: false; reason: string };

function stripNullish(
  checker: ts.TypeChecker,
  type: ts.Type,
): { type: ts.Type; nullable: boolean } {
  if (!type.isUnion()) return { type, nullable: false };
  const rest = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
  if (rest.length === type.types.length || rest.length !== 1 || !rest[0])
    return { type, nullable: false };
  void checker;
  return { type: rest[0], nullable: true };
}

/**
 * Builds the picked object for `name` from its references inside the island. Fails (with a reason)
 * when the island uses the whole object, uses optional chaining or element access on it, or calls
 * ObjectId methods other than toString().
 */
export function pickMongooseFields(
  checker: ts.TypeChecker,
  name: string,
  refs: ts.Identifier[],
  printType: (type: ts.Type) => string,
): PickResult {
  const root: Branch = { kind: "branch", fields: new Map() };
  for (const ref of refs) {
    let node: ts.Expression = ref;
    const path: string[] = [];
    let leafType: ts.Type | undefined;
    for (;;) {
      const parent: ts.Node = node.parent;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) break;
      if (parent.questionDotToken)
        return { ok: false, reason: `uses optional chaining on \`${name}\`` };
      path.push(parent.name.text);
      node = parent;
      const type = checker.getTypeAtLocation(node);
      const { type: inner } = stripNullish(checker, type);
      if (isObjectIdType(inner) || checkSerializable(checker, type).ok) {
        leafType = type;
        break;
      }
    }
    if (path.length === 0) {
      return {
        ok: false,
        reason: `uses \`${name}\` as a whole (spread, passed on, or iterated), so its fields can't be picked`,
      };
    }
    if (!leafType) {
      return {
        ok: false,
        reason: `reads \`${name}.${path.join(".")}\`, which isn't serializable even after picking fields`,
      };
    }
    const { type: inner, nullable } = stripNullish(checker, leafType);
    const objectId = isObjectIdType(inner);
    if (objectId) {
      const after = node.parent;
      if (
        ts.isPropertyAccessExpression(after) &&
        after.expression === node &&
        after.name.text !== "toString"
      ) {
        return {
          ok: false,
          reason: `calls ObjectId.${after.name.text}() on \`${name}.${path.join(".")}\`, which a string doesn't have`,
        };
      }
    }
    // Record the path in the tree.
    let branch = root;
    for (const [i, key] of path.entries()) {
      const last = i === path.length - 1;
      const existing = branch.fields.get(key);
      if (last) {
        if (existing?.kind === "branch")
          return {
            ok: false,
            reason: `reads \`${name}.${path.join(".")}\` both as a value and as an object`,
          };
        if (!existing)
          branch.fields.set(key, {
            kind: "leaf",
            source: `${name}.${path.join(".")}`,
            type: leafType,
            objectId,
            nullable,
          });
      } else {
        if (existing?.kind === "leaf")
          return {
            ok: false,
            reason: `reads \`${name}.${path.slice(0, i + 1).join(".")}\` both as a value and as an object`,
          };
        if (!existing) {
          const next: Branch = { kind: "branch", fields: new Map() };
          branch.fields.set(key, next);
          branch = next;
        } else {
          branch = existing;
        }
      }
    }
  }

  const render = (node: Branch): { expr: string; type: string } => {
    const exprs: string[] = [];
    const types: string[] = [];
    for (const [key, child] of node.fields) {
      const prop = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      if (child.kind === "branch") {
        const inner = render(child);
        exprs.push(`${prop}: ${inner.expr}`);
        types.push(`${prop}: ${inner.type}`);
      } else if (child.objectId) {
        exprs.push(
          child.nullable
            ? `${prop}: ${child.source} == null ? ${child.source} : String(${child.source})`
            : `${prop}: String(${child.source})`,
        );
        types.push(
          `${prop}: ${child.nullable ? `string | ${printNullish(child.type)}` : "string"}`,
        );
      } else {
        exprs.push(`${prop}: ${child.source}`);
        types.push(`${prop}: ${printType(child.type)}`);
      }
    }
    return { expr: `{ ${exprs.join(", ")} }`, type: `{ ${types.join("; ")} }` };
  };
  const rendered = render(root);
  return { ok: true, value: { serverExpr: rendered.expr, typeText: rendered.type } };
}

function printNullish(type: ts.Type): string {
  if (!type.isUnion()) return "null";
  const parts: string[] = [];
  if (type.types.some((t) => t.flags & ts.TypeFlags.Null)) parts.push("null");
  if (type.types.some((t) => t.flags & ts.TypeFlags.Undefined)) parts.push("undefined");
  return parts.join(" | ") || "null";
}
