import { ts } from "ts-morph";
import type { AnalysisContext } from "./context.js";
import { locOf } from "./context.js";
import type { SourceLocation } from "./skip.js";

/** Kinds of risk a change carries without being refused. Codes are stable, like skip codes. */
export const WARNING_CODES = ["timezone-dependent"] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export type Warning = { code: WarningCode; message: string; location?: SourceLocation };

/** Warnings per file, at most; the rest are counted in the last one. */
const MAX_WARNINGS = 5;

const DATE_LIBRARY_RE =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(date-fns|dayjs|moment)\//;

/** date-fns functions whose result depends on the local timezone (date-fns-tz is a different package). */
const DATE_FNS_LOCAL_RE =
  /^(format|lightFormat|intlFormat|formatRelative|formatDistance|formatDistanceToNow|getDate|getDay|getHours|getMinutes|getMonth|getYear|getWeek|getQuarter|startOf\w+|endOf\w+|is(Today|Tomorrow|Yesterday|ThisWeek|ThisMonth|ThisQuarter|ThisYear|SameDay|SameWeek|SameMonth|Weekend|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|FirstDayOfMonth|LastDayOfMonth)|differenceInCalendar\w+|eachDayOfInterval)$/;

/** `Date` methods that read the local timezone (their `getUTC*` counterparts don't). */
const DATE_LOCAL_METHODS = new Set([
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getTimezoneOffset",
  "toDateString",
  "toTimeString",
  "toString",
]);

/** dayjs/moment calls that make `.format()` independent of the local timezone. */
const ZONED_CALLS = new Set(["tz", "utc", "utcOffset"]);

/**
 * Code that formats or reads dates in the local timezone and runs on the server after the change
 * (`stays(node)`): date-fns formatting and calendar functions, `.format()` on a dayjs or moment
 * value that wasn't put in a zone first, and `Date`'s local getters. Before the change it rendered
 * in the browser, in the user's timezone; the HTML is now rendered in the server's.
 * Locale-dependent calls (`toLocaleString`, `Intl`) never get here: they keep code in islands.
 */
export function findTimezoneWarnings(
  ctx: AnalysisContext,
  stays: (node: ts.Node) => boolean,
): Warning[] {
  const { checker, sf } = ctx;
  const found: { node: ts.Node; message: string }[] = [];
  const declaredIn = (symbol: ts.Symbol | undefined): string | undefined => {
    const resolved =
      symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return resolved?.declarations?.[0]?.getSourceFile().fileName;
  };
  const libraryOf = (file: string | undefined) =>
    file ? DATE_LIBRARY_RE.exec(file)?.[1] : undefined;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && stays(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) {
        const name = ts.isIdentifier(callee) ? callee.text : callee.name.text;
        const nameNode = ts.isIdentifier(callee) ? callee : callee.name;
        const library = libraryOf(declaredIn(checker.getSymbolAtLocation(nameNode)));
        if (library === "date-fns" && DATE_FNS_LOCAL_RE.test(name)) {
          found.push({
            node,
            message: `${name}() from date-fns uses the timezone of the machine that renders it, which is now the server; format with an explicit timezone (date-fns-tz's formatInTimeZone) or keep it in an island`,
          });
        } else if (ts.isPropertyAccessExpression(callee)) {
          const receiver = callee.expression;
          const typeSymbol = checker.getTypeAtLocation(receiver).getSymbol();
          const receiverLibrary = libraryOf(declaredIn(typeSymbol));
          if (
            name === "format" &&
            (receiverLibrary === "dayjs" || receiverLibrary === "moment") &&
            !callsInChain(receiver).some((call) => ZONED_CALLS.has(call))
          ) {
            found.push({
              node,
              message: `.format() on a ${receiverLibrary} value uses the timezone of the machine that renders it, which is now the server; call .tz() or .utc() first, or keep it in an island`,
            });
          } else if (
            DATE_LOCAL_METHODS.has(name) &&
            typeSymbol?.getName() === "Date" &&
            /\/lib\.[\w.]*\.d\.ts$/.test(declaredIn(typeSymbol) ?? "")
          ) {
            found.push({
              node,
              message: `Date.prototype.${name}() reads the timezone of the machine that renders it, which is now the server; use the getUTC*() methods or format with an explicit timeZone`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const warnings: Warning[] = found.slice(0, MAX_WARNINGS).map(({ node, message }) => ({
    code: "timezone-dependent",
    message,
    location: locOf(ctx, node),
  }));
  const more = found.length - MAX_WARNINGS;
  const last = warnings[warnings.length - 1];
  if (more > 0 && last) last.message += ` (and ${more} more like this in the file)`;
  return warnings;
}

/** Method names called along a receiver chain: `dayjs(x).utc().add(1, "d")` → add, utc. */
function callsInChain(expr: ts.Expression): string[] {
  const out: string[] = [];
  let current: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(current)) {
      if (ts.isPropertyAccessExpression(current.expression)) {
        out.push(current.expression.name.text);
        current = current.expression.expression;
        continue;
      }
      return out;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return out;
  }
}
