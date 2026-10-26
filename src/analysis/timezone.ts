import { ts } from "ts-morph";
import type { AnalysisContext } from "./context.js";
import { locOf } from "./context.js";
import { calleeLibrary, declaredIn, valueLibrary } from "./dateLibraries.js";
import type { Warning } from "./warnings.js";

export { WARNING_CODES } from "./warnings.js";
export type { Warning, WarningCode } from "./warnings.js";

/** Warnings per file, at most; the rest are counted in the last one. */
const MAX_WARNINGS = 5;

/** How many project helpers deep a call is followed (`a()` calls `b()` calls `format()`). */
const MAX_HELPER_DEPTH = 3;

/**
 * date-fns functions whose result depends on the local timezone (date-fns-tz is a different
 * package). The ones that read the current time (`isToday()`, `formatDistanceToNow()`) stay in
 * islands instead, like `Date.now()`.
 */
const DATE_FNS_LOCAL_RE =
  /^(?:format|lightFormat|intlFormat|formatRelative|formatISO|formatISO9075|formatRFC3339|getDate|getDay|getHours|getMinutes|getMonth|getYear|getWeek|getWeekYear|getWeekOfMonth|getISODay|getISOWeek|getISOWeekYear|getDayOfYear|getQuarter|startOf\w+|endOf\w+|is(?:SameDay|SameWeek|SameMonth|Weekend|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|FirstDayOfMonth|LastDayOfMonth)|differenceInCalendar\w+|eachDayOfInterval)$/;

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

type Finding = { what: string; verb: "uses" | "reads"; advice: string };

/**
 * Code that formats or reads dates in the local timezone and runs on the server after the change
 * (`stays(node)`): date-fns formatting and calendar functions, `.format()` on a dayjs or moment
 * value that wasn't put in a zone first, and `Date`'s local getters, called directly or through
 * functions imported from other project files. Before the change it rendered in the browser, in the
 * user's timezone; the HTML is now rendered in the server's. Locale-dependent calls
 * (`toLocaleString`, `Intl`) and ones that read the clock never get here: they keep code in islands.
 */
export function findTimezoneWarnings(
  ctx: AnalysisContext,
  stays: (node: ts.Node) => boolean,
): Warning[] {
  const { checker, sf } = ctx;
  const found: { node: ts.Node; message: string }[] = [];

  const direct = (call: ts.CallExpression): Finding | undefined => {
    const callee = calleeLibrary(checker, call);
    if (!callee) return undefined;
    const { name, library } = callee;
    if (library === "date-fns" && DATE_FNS_LOCAL_RE.test(name)) {
      return {
        what: `${name}() from date-fns`,
        verb: "uses",
        advice:
          "format with an explicit timezone (date-fns-tz's formatInTimeZone) or keep it in an island",
      };
    }
    if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
    const receiver = call.expression.expression;
    const receiverLibrary = valueLibrary(checker, receiver);
    if (
      name === "format" &&
      (receiverLibrary === "dayjs" || receiverLibrary === "moment") &&
      !callsInChain(receiver).some((c) => ZONED_CALLS.has(c))
    ) {
      return {
        what: `.format() on a ${receiverLibrary} value`,
        verb: "uses",
        advice: "call .tz() or .utc() first, or keep it in an island",
      };
    }
    if (!DATE_LOCAL_METHODS.has(name)) return undefined;
    const typeSymbol = checker.getNonNullableType(checker.getTypeAtLocation(receiver)).getSymbol();
    if (typeSymbol?.getName() !== "Date") return undefined;
    if (!/\/lib\.[\w.]*\.d\.ts$/.test(declaredIn(checker, typeSymbol) ?? "")) return undefined;
    return {
      what: `Date.prototype.${name}()`,
      verb: "reads",
      advice: "use the getUTC*() methods or format with an explicit timeZone",
    };
  };

  /** The body of a function declared in another project file that `call` calls. */
  const helperBody = (call: ts.CallExpression): ts.Node | undefined => {
    const callee = call.expression;
    const nameNode = ts.isIdentifier(callee)
      ? callee
      : ts.isPropertyAccessExpression(callee)
        ? callee.name
        : undefined;
    if (!nameNode) return undefined;
    let symbol = checker.getSymbolAtLocation(nameNode);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl) return undefined;
    const file = decl.getSourceFile();
    // Helpers in this file are scanned with the rest of it.
    if (file === sf || file.isDeclarationFile || /[\\/]node_modules[\\/]/.test(file.fileName))
      return undefined;
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl.body;
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
    )
      return decl.initializer.body;
    return undefined;
  };

  /** The first timezone-dependent call inside a project helper, and where it is. */
  const throughHelper = (
    call: ts.CallExpression,
    depth: number,
    seen: Set<ts.Node>,
  ): (Finding & { at: string }) | undefined => {
    const body = helperBody(call);
    if (!body || seen.has(body) || depth > MAX_HELPER_DEPTH) return undefined;
    seen.add(body);
    let result: (Finding & { at: string }) | undefined;
    const visit = (n: ts.Node): void => {
      if (result) return;
      if (ts.isCallExpression(n)) {
        const finding = direct(n);
        if (finding) {
          const inner = n.getSourceFile();
          const line = inner.getLineAndCharacterOfPosition(n.getStart(inner)).line + 1;
          result = { ...finding, at: `${ctx.graph.rel(inner.fileName)}:${line}` };
          return;
        }
        result = throughHelper(n, depth + 1, seen);
        if (result) return;
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return result;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && stays(node)) {
      const finding = direct(node);
      if (finding) {
        found.push({
          node,
          message: `${finding.what} ${finding.verb} the timezone of the machine that renders it, which is now the server; ${finding.advice}`,
        });
      } else {
        const viaHelper = throughHelper(node, 1, new Set());
        if (viaHelper) {
          found.push({
            node,
            message: `${node.expression.getText(sf)}() calls ${viaHelper.what} (${viaHelper.at}), which ${viaHelper.verb} the timezone of the machine that renders it, now the server; ${viaHelper.advice}`,
          });
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
