import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { split } from "../src/index.js";
import type { FileResult, UserConfig } from "../src/types.js";

const TMP = path.resolve(import.meta.dirname, ".tmp");

/**
 * Writes `files` into a throwaway directory inside the repo (so react/next types resolve) and
 * runs split() on it. Thresholds default to 0 so small examples aren't skipped.
 */
async function splitSources(
  files: Record<string, string>,
  config: UserConfig = {},
  measure = false,
): Promise<FileResult[]> {
  const id = createHash("sha1")
    .update(JSON.stringify(files))
    .update(String(Math.random()))
    .digest("hex")
    .slice(0, 10);
  const root = path.join(TMP, id);
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const result = await split({
      root,
      paths: ["."],
      measure,
      noConfigFile: true,
      config: { minBytesSaved: 0, minStaticRatio: 0, ...config },
    });
    return result.files;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function splitOne(
  source: string,
  extra: Record<string, string> = {},
  config: UserConfig = {},
  measure = false,
): Promise<FileResult> {
  const files = await splitSources({ "Comp.tsx": source, ...extra }, config, measure);
  const file = files.find((f) => f.file === "Comp.tsx");
  if (!file) throw new Error(`no result for Comp.tsx: ${JSON.stringify(files)}`);
  if (file.skipped?.code === "internal-error") throw new Error(file.skipped.message);
  return file;
}
