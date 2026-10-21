import { ts } from "ts-morph";

export function isJsxElementLike(
  node: ts.Node,
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

export function isIntrinsicTagName(name: ts.JsxTagNameExpression): boolean {
  if (ts.isIdentifier(name)) return /^[a-z]/.test(name.text) || name.text.includes("-");
  return ts.isJsxNamespacedName(name);
}

export function tagNameText(
  sf: ts.SourceFile,
  node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
): string {
  if (ts.isJsxFragment(node)) return "Fragment";
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText(sf);
}

/**
 * True if `id` is used as a value reference (not a declaration name, property name, attribute
 * name, intrinsic tag, closing tag or import/export specifier). Type positions are excluded by the
 * walkers, which never descend into type nodes.
 */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.propertyName === id || parent.name === id))
    return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isJsxAttribute(parent) && parent.name === id) return false;
  if (ts.isJsxClosingElement(parent)) return false;
  if (
    (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) &&
    parent.tagName === id
  ) {
    return !isIntrinsicTagName(id);
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportEqualsDeclaration(parent)
  ) {
    return false;
  }
  if (
    (ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
    parent.label === id
  ) {
    return false;
  }
  if (ts.isMetaProperty(parent) || ts.isJsxNamespacedName(parent)) return false;
  return true;
}

/** Skips type-only syntax (type annotations, type arguments, `satisfies`/`as` types...). */
export function isTypeSyntax(node: ts.Node): boolean {
  return ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node);
}

/**
 * Calls `cb` for every value-reference identifier under `node`. `stop` can prune subtrees
 * (used to treat nested JSX elements as separate units).
 */
export function forEachValueRef(
  node: ts.Node,
  cb: (id: ts.Identifier) => void,
  stop?: (n: ts.Node) => boolean,
): void {
  const visit = (n: ts.Node): void => {
    if (n !== node && stop?.(n)) return;
    if (isTypeSyntax(n)) return;
    if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return;
    if (ts.isIdentifier(n)) {
      if (isValueReference(n)) cb(n);
      return;
    }
    if (ts.isJsxElement(n)) {
      // Closing tags repeat the opening tag; visit opening + children only.
      visit(n.openingElement);
      n.children.forEach(visit);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** Every identifier under `node`, including those in type positions (used for import pruning). */
export function forEachIdentifier(node: ts.Node, cb: (id: ts.Identifier) => void): void {
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) cb(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
}

export function symbolOfRef(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(id.parent);
  }
  return checker.getSymbolAtLocation(id);
}

/** Names declared by a binding name (identifier or destructuring pattern). */
export function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    out.push(...bindingIdentifiers(element.name));
  }
  return out;
}

export function containsRange(
  outer: { pos: number; end: number },
  inner: { pos: number; end: number },
): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

/** The `.map(cb)` call whose first argument is `fn`, if any. */
export function mapCallOf(fn: ts.Node): ts.CallExpression | undefined {
  const parent = fn.parent;
  if (
    parent &&
    ts.isCallExpression(parent) &&
    parent.arguments[0] === fn &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === "map"
  ) {
    return parent;
  }
  return undefined;
}

export function stripParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

export const HOOK_NAME_RE = /^use[A-Z]/;

/** The called name for `foo()` / `React.foo()` / `a.b.foo()`. */
export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}
