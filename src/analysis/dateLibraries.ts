import { ts } from "ts-morph";

export type DateLibrary = "date-fns" | "dayjs" | "moment";

const DATE_LIBRARY_RE =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(date-fns|dayjs|moment)\//;

/** date-fns functions that read the current time. */
const DATE_FNS_NOW_RE =
  /^(?:formatDistanceToNow(?:Strict)?|is(?:Today|Tomorrow|Yesterday|Past|Future|This(?:Year|Quarter|Month|Week|ISOWeek|Hour|Minute|Second)))$/;

/** The file a symbol is declared in, through import aliases. */
export function declaredIn(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): string | undefined {
  const resolved =
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved?.declarations?.[0]?.getSourceFile().fileName;
}

export function dateLibraryOf(file: string | undefined): DateLibrary | undefined {
  return file ? (DATE_LIBRARY_RE.exec(file)?.[1] as DateLibrary | undefined) : undefined;
}

/** The date library a call's callee (`format`, `dfns.format`, `dayjs`) comes from. */
export function calleeLibrary(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): { name: string; library: DateLibrary | undefined } | undefined {
  const callee = call.expression;
  if (!ts.isIdentifier(callee) && !ts.isPropertyAccessExpression(callee)) return undefined;
  const nameNode = ts.isIdentifier(callee) ? callee : callee.name;
  return {
    name: nameNode.text,
    library: dateLibraryOf(declaredIn(checker, checker.getSymbolAtLocation(nameNode))),
  };
}

/** The date library whose value an expression is (a `Dayjs` or `Moment`). */
export function valueLibrary(
  checker: ts.TypeChecker,
  expr: ts.Expression,
): DateLibrary | undefined {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(expr));
  return dateLibraryOf(declaredIn(checker, type.getSymbol()));
}

/**
 * Calls that read the current time through a date library, so they render differently on the
 * server (or at build time) and in the browser, like `Date.now()`: date-fns `formatDistanceToNow()`
 * and `isToday()`-style checks, `dayjs()`/`moment()` (and `.utc()`/`.tz()`) without a date, and
 * `.fromNow()`/`.toNow()`/`.calendar()` on their values.
 */
export function clockReadingCall(checker: ts.TypeChecker, n: ts.Node): string | undefined {
  if (!ts.isCallExpression(n)) return undefined;
  const callee = calleeLibrary(checker, n);
  if (!callee) return undefined;
  const { name, library } = callee;
  if (library === "date-fns") return DATE_FNS_NOW_RE.test(name) ? `${name}()` : undefined;
  const noDate = n.arguments.length === 0;
  if ((library === "dayjs" || library === "moment") && noDate && ts.isIdentifier(n.expression))
    return `${name}()`;
  if (!ts.isPropertyAccessExpression(n.expression)) return undefined;
  const owner = n.expression.expression;
  if ((library === "dayjs" || library === "moment") && noDate && ts.isIdentifier(owner)) {
    const ownerLibrary = dateLibraryOf(declaredIn(checker, checker.getSymbolAtLocation(owner)));
    if (ownerLibrary && (name === "utc" || name === "tz")) return `${owner.text}.${name}()`;
  }
  const receiver = valueLibrary(checker, owner);
  if (receiver !== "dayjs" && receiver !== "moment") return undefined;
  if (name === "fromNow" || name === "toNow" || (name === "calendar" && noDate))
    return `.${name}()`;
  return undefined;
}
