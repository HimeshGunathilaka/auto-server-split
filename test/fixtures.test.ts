import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { split } from "../src/index.js";
import type { UserConfig } from "../src/types.js";

/**
 * Walks every folder under fixtures/. Each has `input/` and either `output/` (the exact set of
 * touched/created files) or `expected-skip.json` ({ file, code, messageIncludes? }).
 * An optional `fixture.json` holds { config?, measure? }.
 *
 * UPDATE_FIXTURES=1 rewrites `output/` from the current result. Review those diffs by hand.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
const UPDATE = process.env.UPDATE_FIXTURES === "1";

type FixtureMeta = { config?: UserConfig; measure?: boolean; only?: string[] };
type ExpectedSkip = { file: string; code: string; messageIncludes?: string };

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

const fixtures = existsSync(FIXTURES_DIR)
  ? readdirSync(FIXTURES_DIR)
      .filter((name) => statSync(path.join(FIXTURES_DIR, name)).isDirectory())
      .sort()
  : [];

describe("fixture runner", () => {
  it("finds the fixtures directory", () => {
    expect(existsSync(FIXTURES_DIR)).toBe(true);
  });
});

describe.each(fixtures)("fixture %s", (name) => {
  const dir = path.join(FIXTURES_DIR, name);
  const inputDir = path.join(dir, "input");
  const outputDir = path.join(dir, "output");
  const meta = readJson<FixtureMeta>(path.join(dir, "fixture.json")) ?? {};
  const expectedSkip = readJson<ExpectedSkip>(path.join(dir, "expected-skip.json"));

  it(expectedSkip ? `skips with ${expectedSkip.code}` : "matches output/", async () => {
    const result = await split({
      root: inputDir,
      paths: meta.only ?? ["."],
      write: false,
      measure: meta.measure ?? false,
      config: { minBytesSaved: 0, ...meta.config },
    });

    for (const file of result.files) {
      if (file.skipped?.code === "internal-error") {
        throw new Error(`internal error in ${file.file}: ${file.skipped.message}`);
      }
    }

    if (expectedSkip) {
      const file = result.files.find((f) => f.file === expectedSkip.file);
      expect(file, `no result for ${expectedSkip.file}`).toBeDefined();
      expect({
        status: file?.status,
        code: file?.skipped?.code,
        message: file?.skipped?.message,
      }).toMatchObject({
        status: "skipped",
        code: expectedSkip.code,
      });
      if (expectedSkip.messageIncludes)
        expect(file?.skipped?.message).toContain(expectedSkip.messageIncludes);
      const touched = result.files.flatMap((f) => Object.keys(f.outputs));
      expect(touched, "a skip fixture must not produce outputs").toEqual([]);
      return;
    }

    const actual: Record<string, string> = {};
    for (const file of result.files) Object.assign(actual, file.outputs);

    if (UPDATE) {
      rmSync(outputDir, { recursive: true, force: true });
      for (const [rel, content] of Object.entries(actual)) {
        const target = path.join(outputDir, rel);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }

    const skipped = result.files
      .filter((f) => f.status === "skipped")
      .map((f) => `${f.file}: ${f.skipped?.code} ${f.skipped?.message}`);
    const expectedFiles = listFiles(outputDir);
    expect(Object.keys(actual).sort(), `skips: ${skipped.join("\n")}`).toEqual(expectedFiles);
    for (const rel of expectedFiles) {
      expect(actual[rel], rel).toBe(readFileSync(path.join(outputDir, rel), "utf8"));
    }
  });
});
