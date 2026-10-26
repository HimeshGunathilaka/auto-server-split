import type { SourceLocation } from "./skip.js";

/**
 * Kinds of risk a change carries without being refused. Codes are stable, like skip codes.
 * - `timezone-dependent`: date code that rendered in the browser now renders on the server.
 * - `ignore-outside-header`: an `auto-server-split-ignore` comment that doesn't apply where it is.
 */
export const WARNING_CODES = ["timezone-dependent", "ignore-outside-header"] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

export type Warning = { code: WarningCode; message: string; location?: SourceLocation };
