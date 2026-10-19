import type { SplitOptions, SplitResult, UserConfig } from "./types.js";

export type * from "./types.js";
export { SKIP_CODES, SKIP_TITLES } from "./analysis/skip.js";

export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export async function split(_options: SplitOptions = {}): Promise<SplitResult> {
  return { files: [] };
}
