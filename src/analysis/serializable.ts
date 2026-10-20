import { ts } from "ts-morph";

type Verdict = { ok: true } | { ok: false; reason: string };

const OK: Verdict = { ok: true };
const fail = (reason: string): Verdict => ({ ok: false, reason });

/** Built-in object types React can serialize across the server/client boundary. */
const BUILTIN_SERIALIZABLE = new Set([
  "Date",
  "ArrayBuffer",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "FormData",
]);
/** Container types whose type arguments must themselves be serializable. */
const BUILTIN_CONTAINERS = new Set([
  "Map",
  "ReadonlyMap",
  "Set",
  "ReadonlySet",
  "Promise",
  "PromiseLike",
  "Array",
  "ReadonlyArray",
  "Iterable",
]);
/** React element / node types (JSX is serializable). */
const REACT_NODE_TYPES = new Set([
  "ReactElement",
  "ReactPortal",
  "Element",
  "ReactNode",
  "AwaitedReactNode",
  "JSXElementConstructor",
]);

type SerializableOptions = {
  /** Untyped (.js/.jsx) files: only primitives can be proven. */
  primitivesOnly?: boolean;
};

/**
 * True if the symbol is declared by a file matching `test` and only augmented by other ambient
 * declarations (e.g. @types/react adds an empty `interface FormData {}` in global.d.ts).
 */
function isFromDeclarationFile(
  symbol: ts.Symbol | undefined,
  test: (fileName: string) => boolean,
): boolean {
  const decls = symbol?.declarations ?? [];
  return (
    decls.some((d) => test(d.getSourceFile().fileName)) &&
    decls.every((d) => d.getSourceFile().isDeclarationFile)
  );
}

/** TypeScript's lib files, plus the Node/undici declarations of the same web globals (FormData...). */
const isLibFile = (f: string) =>
  /\/lib\.[a-z0-9.]*\.d\.ts$/.test(f) || /\/@types\/node\//.test(f) || /\/undici-types\//.test(f);
const isReactTypes = (f: string) => /\/@types\/react\//.test(f) || /\/react\/[^/]*\.d\.ts$/.test(f);

/**
 * Proves (or refuses) that values of `type` can be passed from a Server Component to a Client
 * Component, following the React "Serializable types" rules. Anything the checker can't prove is
 * rejected.
 */
export function checkSerializable(
  checker: ts.TypeChecker,
  type: ts.Type,
  options: SerializableOptions = {},
): Verdict {
  const seen = new Set<ts.Type>();

  const visit = (t: ts.Type, depth: number): Verdict => {
    if (depth > 40) return fail("is too deeply nested to verify");
    const flags = t.flags;
    const text = () => checker.typeToString(t);

    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      const unresolved = "intrinsicName" in t && t.intrinsicName === "error";
      return fail(
        unresolved
          ? `has the type \`${text()}\`, which couldn't be resolved (missing import or generated types?)`
          : `is \`${text()}\`, which can't be proven serializable`,
      );
    }
    if (flags & ts.TypeFlags.Never) return fail("is `never`");
    if (
      flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.EnumLike)
    ) {
      return OK;
    }
    if (options.primitivesOnly)
      return fail(`has the non-primitive type \`${text()}\` in an untyped file`);
    // React nodes / elements (JSX) are serializable; check the alias before expanding the union.
    if (
      t.aliasSymbol &&
      REACT_NODE_TYPES.has(t.aliasSymbol.getName()) &&
      isFromDeclarationFile(t.aliasSymbol, isReactTypes)
    ) {
      return OK;
    }
    if (flags & ts.TypeFlags.UniqueESSymbol && isSymbolForDeclaration(t.getSymbol())) return OK;
    if (flags & ts.TypeFlags.ESSymbolLike)
      return fail("is a symbol (only Symbol.for symbols are serializable)");
    if (t.isUnion()) {
      for (const member of t.types) {
        const v = visit(member, depth + 1);
        if (!v.ok) return v;
      }
      return OK;
    }
    if (t.isIntersection()) {
      for (const member of t.types) {
        const v = visit(member, depth + 1);
        if (!v.ok) return v;
      }
      return OK;
    }
    if (flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(t);
      return constraint && constraint !== t
        ? visit(constraint, depth + 1)
        : fail(`is the unconstrained type parameter \`${text()}\``);
    }
    if (!(flags & ts.TypeFlags.Object) && !(flags & ts.TypeFlags.NonPrimitive))
      return fail(`has the type \`${text()}\``);
    if (flags & ts.TypeFlags.NonPrimitive)
      return fail("is `object`, which can't be proven serializable");

    if (seen.has(t)) return OK; // recursive types: the other branches decide
    seen.add(t);

    const symbol = t.getSymbol();
    const aliasSymbol = t.aliasSymbol;
    const name = symbol?.getName();

    if (
      (aliasSymbol &&
        REACT_NODE_TYPES.has(aliasSymbol.getName()) &&
        isFromDeclarationFile(aliasSymbol, isReactTypes)) ||
      (name && REACT_NODE_TYPES.has(name) && isFromDeclarationFile(symbol, isReactTypes))
    ) {
      return OK;
    }

    if (name && BUILTIN_SERIALIZABLE.has(name) && isFromDeclarationFile(symbol, isLibFile))
      return OK;

    if (checker.isArrayType(t) || checker.isTupleType(t)) {
      for (const arg of checker.getTypeArguments(t as ts.TypeReference)) {
        const v = visit(arg, depth + 1);
        if (!v.ok) return fail(`contains an element that ${v.reason}`);
      }
      return OK;
    }

    if (name && BUILTIN_CONTAINERS.has(name) && isFromDeclarationFile(symbol, isLibFile)) {
      const args = (t as ts.TypeReference).target
        ? checker.getTypeArguments(t as ts.TypeReference)
        : [];
      for (const arg of args) {
        const v = visit(arg, depth + 1);
        if (!v.ok) return fail(`contains a ${name} value that ${v.reason}`);
      }
      return OK;
    }

    if (t.getCallSignatures().length > 0 || t.getConstructSignatures().length > 0) {
      return fail(`is a function (\`${text()}\`)`);
    }

    // Class instances and built-in/library object types other than the ones above are rejected.
    if (symbol && symbol.flags & ts.SymbolFlags.Class)
      return fail(`is an instance of the class ${name ?? text()}`);
    if (
      symbol &&
      isFromDeclarationFile(symbol, isLibFile) &&
      !(symbol.flags & ts.SymbolFlags.TypeLiteral) &&
      name !== "__object"
    ) {
      return fail(`is a built-in \`${name}\` object, which React can't serialize`);
    }
    if (symbol && symbol.declarations?.some((d) => ts.isClassLike(d)))
      return fail(`is an instance of the class ${name}`);

    // Plain object: every property (and index signature) must be serializable.
    for (const prop of checker.getPropertiesOfType(t)) {
      if (prop.flags & ts.SymbolFlags.Method) return fail(`has the method \`${prop.getName()}\``);
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getTypeOfSymbol(prop);
      const v = visit(propType, depth + 1);
      if (!v.ok) return fail(`has a property \`${prop.getName()}\` that ${v.reason}`);
    }
    for (const info of checker.getIndexInfosOfType(t)) {
      const v = visit(info.type, depth + 1);
      if (!v.ok) return fail(`has index values that ${v.reason}`);
    }
    return OK;
  };

  return visit(type, 0);
}

/** `const KEY = Symbol.for("...")`: a globally registered symbol, which React can serialize. */
function isSymbolForDeclaration(symbol: ts.Symbol | undefined): boolean {
  const decl = symbol?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  const init = decl.initializer;
  return (
    ts.isCallExpression(init) &&
    ts.isPropertyAccessExpression(init.expression) &&
    ts.isIdentifier(init.expression.expression) &&
    init.expression.expression.text === "Symbol" &&
    init.expression.name.text === "for"
  );
}

/** True if values of this type can be called (a function or a union containing one). */
export function isCallableType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(isCallableType);
  return type.getCallSignatures().length > 0;
}
