/**
 * Every reason the tool can decline to split a file. Codes are stable: they appear in
 * JSON output, CI logs and docs/skip-reasons.md, so never rename one.
 */
export const SKIP_CODES = [
  "imported-by-client",
  "exports-non-components",
  "state-spans-component",
  "context-provider",
  "css-in-js-runtime",
  "non-serializable-prop",
  "untyped-boundary",
  "spread-props",
  "conditional-hooks-or-returns",
  "class-component",
  "dynamic-import",
  "render-prop",
  "hoc",
  "server-env-difference",
  "no-islands",
  "fully-interactive",
  "below-threshold",
  "output-exists",
  "would-create-route",
  "unsupported-pattern",
  "self-check-failed",
  "parse-error",
  "internal-error",
] as const;

export type SkipCode = (typeof SKIP_CODES)[number];

export type SourceLocation = { line: number; column: number };

export type Skip = {
  code: SkipCode;
  message: string;
  location?: SourceLocation;
};

/** Short, human-readable titles used when grouping skips in the CLI summary. */
export const SKIP_TITLES: Record<SkipCode, string> = {
  "imported-by-client": "imported by a client module",
  "exports-non-components": "exports something other than components and types",
  "state-spans-component": "client state spans the whole component",
  "context-provider": "creates or provides a React Context",
  "css-in-js-runtime": "uses runtime CSS-in-JS",
  "non-serializable-prop": "a value crossing the boundary is not serializable",
  "untyped-boundary": "untyped file: boundary values can't be proven serializable",
  "spread-props": "spread props can't be proven serializable",
  "conditional-hooks-or-returns": "conditional hooks or client-dependent early returns",
  "class-component": "contains a class component",
  "dynamic-import": "uses next/dynamic or React.lazy",
  "render-prop": "uses a render prop or function-as-child",
  hoc: "wrapped in memo/forwardRef or another higher-order component",
  "server-env-difference": "reads an env var that differs between server and client",
  "no-islands": "no client-only code found (the directive may be unnecessary)",
  "fully-interactive": "nothing would stay on the server",
  "below-threshold": "saving is below the configured threshold",
  "output-exists": "the generated file already exists",
  "would-create-route": "the generated file could become a route",
  "unsupported-pattern": "uses a pattern this version does not handle",
  "self-check-failed": "the generated code failed the self-check",
  "parse-error": "the file could not be parsed",
  "internal-error": "internal error (please report)",
};

/** Expected skips are values, never exceptions. Analysis steps return `Outcome<T>`. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; skip: Skip };

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function skip(
  code: SkipCode,
  message: string,
  location?: SourceLocation,
): { ok: false; skip: Skip } {
  return { ok: false, skip: location ? { code, message, location } : { code, message } };
}

export function isSkipCode(value: unknown): value is SkipCode {
  return typeof value === "string" && (SKIP_CODES as readonly string[]).includes(value);
}
