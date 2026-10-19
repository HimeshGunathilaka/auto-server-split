import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PrettierApi = {
  resolveConfigFile(file: string): Promise<string | null>;
  resolveConfig(
    file: string,
    options?: { config?: string },
  ): Promise<Record<string, unknown> | null>;
  format(source: string, options: Record<string, unknown>): Promise<string>;
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

/**
 * Formats `text` as `file` with the project's Prettier config. Returns the text unchanged when the
 * project has no Prettier installed or no Prettier config applies to the file.
 */
export async function formatWithProjectPrettier(
  root: string,
  file: string,
  text: string,
): Promise<string> {
  const prettier = await loadPrettier(root);
  if (!prettier) return text;
  const configFile = await prettier.resolveConfigFile(file);
  // Only a config that belongs to this project counts (not one in a parent directory).
  if (!configFile || path.relative(root, configFile).startsWith("..")) return text;
  const options = (await prettier.resolveConfig(file, { config: configFile })) ?? {};
  return prettier.format(text, { ...options, filepath: file });
}
