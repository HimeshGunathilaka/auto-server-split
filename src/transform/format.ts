import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lineEndingOf } from "./text.js";

type PrettierApi = {
  resolveConfigFile(file: string): Promise<string | null>;
  resolveConfig(
    file: string,
    options?: { config?: string },
  ): Promise<Record<string, unknown> | null>;
  format(source: string, options: Record<string, unknown>): Promise<string>;
  check(source: string, options: Record<string, unknown>): Promise<boolean>;
};

const cache = new Map<string, Promise<PrettierApi | undefined>>();

/** Loads the project's own Prettier (never ours), if it has one. */
function loadPrettier(root: string): Promise<PrettierApi | undefined> {
  let pending = cache.get(root);
  if (!pending) {
    pending = (async () => {
      try {
        const require = createRequire(path.join(root, "package.json"));
        const entry = require.resolve("prettier");
        const mod = (await import(pathToFileURL(entry).href)) as PrettierApi & {
          default?: PrettierApi;
        };
        // CJS entry points expose the API on `default`.
        return typeof mod.format === "function" ? mod : mod.default;
      } catch {
        return undefined;
      }
    })();
    cache.set(root, pending);
  }
  return pending;
}

export type Formatter = (file: string, text: string) => Promise<string>;

/**
 * A formatter for the files a split of `file` produces, using the project's Prettier config.
 * Undefined when the project has no Prettier or no config applies to the file, and also when the
 * original isn't already formatted with that config: formatting would then rewrite lines the split
 * didn't touch. Line endings always follow the original (`endOfLine` is set from its first line).
 */
export async function projectFormatter(
  root: string,
  file: string,
  originalText: string,
): Promise<Formatter | undefined> {
  const prettier = await loadPrettier(root);
  if (!prettier) return undefined;
  const configFile = await prettier.resolveConfigFile(file);
  // Only a config that belongs to this project counts (not one in a parent directory).
  if (!configFile || path.relative(root, configFile).startsWith("..")) return undefined;
  const endOfLine = lineEndingOf(originalText) === "\r\n" ? "crlf" : "lf";
  const optionsFor = async (target: string) => ({
    ...((await prettier.resolveConfig(target, { config: configFile })) ?? {}),
    endOfLine,
    filepath: target,
  });
  try {
    if (!(await prettier.check(originalText, await optionsFor(file)))) return undefined;
  } catch {
    return undefined; // Prettier can't parse it (syntax it doesn't support): leave it alone
  }
  return async (target, text) => prettier.format(text, await optionsFor(target));
}
