import { matchesPackageList } from "./clientPackages.js";

/** The `rules` config: declarative safety rules for packages, exports and calls. */
export type RulesConfig = {
  /** Client-only imports: a package (`"my-ui"`, `"@scope/*"`, `"pkg/sub"`) or one export (`"pkg#useThing"`). */
  clientOnlyImports?: string[];
  /** React packages, or single exports (`"my-ui#Icon"`), that render correctly as Server Components. */
  serverSafeExports?: string[];
  /**
   * Calls whose result differs between the server and the browser, kept in islands like
   * `Date.now()`: an imported function (`"my-dates#today"`) or a global (`"performance.now"`).
   */
  browserDependentCalls?: string[];
  /** Calls to warn about when they move to the server, with the message to show. */
  warnings?: { call: string; message: string }[];
};

/** A call as rules name it: an export of an imported module, or a global path. */
export type CallTarget = { specifier: string; exportName: string } | { global: string };

type Pattern = { module: string; name: string | undefined };

function parse(entry: string): Pattern {
  const hash = entry.indexOf("#");
  return hash === -1
    ? { module: entry, name: undefined }
    : { module: entry.slice(0, hash), name: entry.slice(hash + 1) };
}

/** `rules` entries, compiled once per run. */
export class SafetyRules {
  /** Whole packages named in `clientOnlyImports` (they join `clientOnlyPackages`). */
  readonly clientOnlyPackages: string[];
  /** Whole packages named in `serverSafeExports` (they join `serverSafePackages`). */
  readonly serverSafePackages: string[];
  private readonly clientOnlyExports: Pattern[];
  private readonly serverSafeExports: Pattern[];
  private readonly browserCalls: string[];
  private readonly warningCalls: { call: string; message: string }[];

  constructor(config: RulesConfig = {}) {
    const clientOnly = (config.clientOnlyImports ?? []).map(parse);
    const serverSafe = (config.serverSafeExports ?? []).map(parse);
    this.clientOnlyPackages = clientOnly.filter((p) => !p.name).map((p) => p.module);
    this.serverSafePackages = serverSafe.filter((p) => !p.name).map((p) => p.module);
    this.clientOnlyExports = clientOnly.filter((p) => p.name);
    this.serverSafeExports = serverSafe.filter((p) => p.name);
    this.browserCalls = config.browserDependentCalls ?? [];
    this.warningCalls = config.warnings ?? [];
  }

  /** Whether a rule names this export of an external module (client-only rules win). */
  exportRule(
    specifier: string,
    exportName: string | undefined,
  ): "client-only" | "server-safe" | undefined {
    if (exportName === undefined) return undefined;
    const matches = (p: Pattern) =>
      p.name === exportName && matchesPackageList(specifier, [p.module]);
    if (this.clientOnlyExports.some(matches)) return "client-only";
    if (this.serverSafeExports.some(matches)) return "server-safe";
    return undefined;
  }

  get hasCallRules(): boolean {
    return this.browserCalls.length > 0 || this.warningCalls.length > 0;
  }

  /** The `browserDependentCalls` entry a call matches. */
  browserDependent(target: CallTarget): string | undefined {
    return this.browserCalls.find((entry) => callMatches(entry, target));
  }

  /** The `warnings` entry a call matches. */
  warning(target: CallTarget): { call: string; message: string } | undefined {
    return this.warningCalls.find((rule) => callMatches(rule.call, target));
  }
}

function callMatches(entry: string, target: CallTarget): boolean {
  const pattern = parse(entry);
  if ("global" in target) return pattern.name === undefined && pattern.module === target.global;
  return (
    pattern.name === target.exportName && matchesPackageList(target.specifier, [pattern.module])
  );
}

/** How a call reads in messages: `today()` from my-dates, `performance.now()`. */
export function describeCall(target: CallTarget): string {
  return "global" in target
    ? `${target.global}()`
    : `${target.exportName}() from ${target.specifier}`;
}
