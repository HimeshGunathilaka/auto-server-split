import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedConfig, UserConfig } from "../types.js";

export const DEFAULT_CONFIG: ResolvedConfig = {
  include: ["app/**", "components/**", "src/**"],
  exclude: ["**/*.test.*", "**/*.spec.*", "**/*.stories.*"],
  clientOnlyPackages: [],
  serverSafeHooks: [],
  clientFileSuffix: ".client",
  islandsDir: undefined,
  minBytesSaved: 2048,
  minStaticRatio: 0.3,
  prettier: "auto",
  mongoose: { autoSerialize: false },
};

export const CONFIG_FILES = [
  "auto-split.config.ts",
  "auto-split.config.mts",
  "auto-split.config.mjs",
  "auto-split.config.js",
  "auto-split.config.json",
];

export class ConfigError extends Error {}

const KEYS: Record<keyof UserConfig, (v: unknown) => string | undefined> = {
  include: stringArray,
  exclude: stringArray,
  clientOnlyPackages: stringArray,
  serverSafeHooks: stringArray,
  clientFileSuffix: (v) =>
    typeof v === "string" && /^\.[\w.-]+$/.test(v)
      ? undefined
      : 'must be a string starting with "." (e.g. ".client")',
  islandsDir: (v) =>
    typeof v === "string" && v.length > 0 && !path.isAbsolute(v) && !v.includes("..")
      ? undefined
      : "must be a relative directory name",
  minBytesSaved: (v) =>
    typeof v === "number" && v >= 0 && Number.isFinite(v)
      ? undefined
      : "must be a non-negative number",
  minStaticRatio: (v) =>
    typeof v === "number" && v >= 0 && v <= 1 ? undefined : "must be a number between 0 and 1",
  prettier: (v) => (v === "auto" || v === false ? undefined : 'must be "auto" or false'),
  mongoose: (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return "must be an object";
    for (const [k, val] of Object.entries(v)) {
      if (k !== "autoSerialize") return `has an unknown key "${k}" (allowed: autoSerialize)`;
      if (typeof val !== "boolean") return "autoSerialize must be a boolean";
    }
    return undefined;
  },
};

function stringArray(v: unknown): string | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? undefined
    : "must be an array of strings";
}

/** Validates a user config object; throws ConfigError with every problem listed. */
export function validateConfig(value: unknown, source: string): UserConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${source}: the config must be an object`);
  }
  const problems: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    const check = KEYS[key as keyof UserConfig];
    if (!check) {
      problems.push(`unknown key "${key}" (allowed: ${Object.keys(KEYS).join(", ")})`);
      continue;
    }
    if (v === undefined) continue;
    const problem = check(v);
    if (problem) problems.push(`"${key}" ${problem}`);
  }
  if (problems.length > 0) throw new ConfigError(`${source}:\n  - ${problems.join("\n  - ")}`);
  return value as UserConfig;
}

export function resolveConfig(...layers: (UserConfig | undefined)[]): ResolvedConfig {
  const out: ResolvedConfig = { ...DEFAULT_CONFIG, mongoose: { ...DEFAULT_CONFIG.mongoose } };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (key === "mongoose")
        out.mongoose = { ...out.mongoose, ...(value as UserConfig["mongoose"]) };
      else (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

export function findConfigFile(root: string): string | undefined {
  return CONFIG_FILES.map((f) => path.join(root, f)).find((f) => existsSync(f));
}

/** Loads auto-split.config.{ts,mts,mjs,js,json}. TypeScript configs are compiled with esbuild first. */
export async function loadConfigFile(file: string): Promise<UserConfig> {
  const rel = path.basename(file);
  let raw: unknown;
  if (file.endsWith(".json")) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new ConfigError(`${rel}: invalid JSON (${(error as Error).message})`);
    }
  } else if (file.endsWith(".ts") || file.endsWith(".mts")) {
    const esbuild = await import("esbuild");
    const result = await esbuild.build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
      plugins: [
        {
          name: "auto-split-shim",
          setup(build) {
            build.onResolve({ filter: /^auto-server-split$/ }, () => ({
              path: "shim",
              namespace: "auto-split-shim",
            }));
            build.onLoad({ filter: /.*/, namespace: "auto-split-shim" }, () => ({
              contents: "export const defineConfig = (c) => c;",
              loader: "js",
            }));
          },
        },
      ],
    });
    const code = result.outputFiles[0]?.text ?? "";
    const temp = path.join(
      path.dirname(file),
      `.auto-split.config.${process.pid}.${Date.now()}.mjs`,
    );
    writeFileSync(temp, code);
    try {
      raw = ((await import(pathToFileURL(temp).href)) as { default?: unknown }).default;
    } finally {
      rmSync(temp, { force: true });
    }
  } else {
    raw = ((await import(pathToFileURL(file).href)) as { default?: unknown }).default;
  }
  return validateConfig(raw, rel);
}
