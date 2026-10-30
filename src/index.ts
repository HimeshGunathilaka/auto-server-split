import { runSplit } from "./split.js";
import type { SplitOptions, SplitResult, UserConfig } from "./types.js";

export type * from "./types.js";
export { SKIP_CODES, SKIP_TITLES } from "./analysis/skip.js";
export { WARNING_CODES } from "./analysis/warnings.js";
export { explain } from "./explain.js";
export { ConfigError } from "./config/config.js";
export { SnapshotError } from "./split.js";
export type { Explanation } from "./explain.js";

/** Identity helper that gives `auto-split.config.ts` type checking. */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

/**
 * Finds partly-interactive "use client" components and splits them into a Server Component plus
 * generated client islands. Nothing is written unless `write: true`.
 */
export async function split(options: SplitOptions = {}): Promise<SplitResult> {
  const { files, routes, summary } = await runSplit(options);
  return { files, ...(routes ? { routes } : {}), summary };
}
