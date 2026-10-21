import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as prettier from "prettier";
import { afterAll, describe, expect, it } from "vitest";
import { split } from "../src/index.js";
import { runSplit } from "../src/split.js";
import type { UserConfig } from "../src/types.js";

/**
 * Files saved with Windows line endings (CRLF) must come out with CRLF on every line: the
 * rewritten file and the generated island file. Every fixture with an `output/` is rerun on a CRLF
 * copy of its input and must produce exactly the expected files, with CRLF line endings.
 */

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");
const TMP = path.resolve(import.meta.dirname, ".tmp");
const SOURCE_RE = /\.(tsx?|jsx?|mts|mjs)$/;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory()
      ? listFiles(full, base)
      : [path.relative(base, full).split(path.sep).join("/")];
  });
}

function tempDir(name: string): string {
  const dir = path.join(TMP, `eol-${name}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return dir;
}

function project(files: Record<string, string>): string {
  const root = tempDir("project");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const fixtures = readdirSync(FIXTURES_DIR)
  .filter((name) => existsSync(path.join(FIXTURES_DIR, name, "output")))
  .sort();

describe("CRLF input gives CRLF output", () => {
  it.each(fixtures)("%s", async (name) => {
    const dir = path.join(FIXTURES_DIR, name);
    const metaFile = path.join(dir, "fixture.json");
    const meta = (existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {}) as {
      config?: UserConfig;
      measure?: boolean;
      only?: string[];
    };
    const root = tempDir(name);
    cpSync(path.join(dir, "input"), root, { recursive: true });
    for (const rel of listFiles(root)) {
      const file = path.join(root, rel);
      if (SOURCE_RE.test(rel)) writeFileSync(file, crlf(readFileSync(file, "utf8")));
    }

    const result = await split({
      root,
      paths: meta.only ?? ["."],
      measure: meta.measure ?? false,
      config: { minBytesSaved: 0, ...meta.config },
    });
    const actual: Record<string, string> = {};
    for (const file of result.files) Object.assign(actual, file.outputs);

    const outputDir = path.join(dir, "output");
    const expected = listFiles(outputDir).sort();
    expect(Object.keys(actual).sort()).toEqual(expected);
    for (const rel of expected) {
      expect(actual[rel], rel).toBe(crlf(readFileSync(path.join(outputDir, rel), "utf8")));
    }
  });
});

const POST_CARD = `"use client";
import { format } from "date-fns";
import { useState } from "react";

export default function PostCard({ title, date }: { title: string; date: string }) {
  const [liked, setLiked] = useState(false);
  return (
    <article>
      <h2>{title}</h2>
      <time>{format(new Date(date), "PPP")}</time>
      <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>
    </article>
  );
}
`;

async function splitPostCard(source: string, extra: Record<string, string> = {}) {
  const root = project({ "PostCard.tsx": source, ...extra });
  const { files } = await split({
    root,
    paths: ["PostCard.tsx"],
    measure: false,
    noConfigFile: true,
    config: { minBytesSaved: 0 },
  });
  const [file] = files;
  expect(file?.status).toBe("split");
  return {
    server: file?.outputs["PostCard.tsx"] ?? "",
    island: file?.outputs["PostCard.client.tsx"] ?? "",
  };
}

describe("line endings", () => {
  it("keeps LF files LF", async () => {
    const { server, island } = await splitPostCard(POST_CARD);
    expect(server).not.toContain("\r");
    expect(island).not.toContain("\r");
  });

  it("keeps a file that already mixes CRLF and LF byte for byte, and gives the island CRLF", async () => {
    // CRLF everywhere except the line declaring the component.
    const lines = POST_CARD.split("\n");
    const mixed = lines
      .map((line, i) =>
        i === lines.length - 1
          ? line
          : `${line}${line.startsWith("export default") ? "\n" : "\r\n"}`,
      )
      .join("");
    const { server, island } = await splitPostCard(mixed);
    expect(server).toContain(
      "export default function PostCard({ title, date }: { title: string; date: string }) {\n",
    );
    expect(server).toContain("    <article>\r\n      <h2>{title}</h2>\r\n");
    expect(island).not.toMatch(/(?:^|[^\r])\n/);
    expect(island).toContain("\r\n");
  });

  it("keeps the original's line endings when a split is re-run (interactive renames)", async () => {
    const changedLines = (diff: string) =>
      diff.split("\n").filter((line) => /^[-+](?![-+]{2} )/.test(line)).length;
    const lines = POST_CARD.split("\n");
    const mixed = lines
      .map((line, i) => (i === lines.length - 1 ? line : `${line}${i === 4 ? "\n" : "\r\n"}`))
      .join("");
    for (const source of [crlf(POST_CARD), mixed]) {
      const root = project({ "PostCard.tsx": source });
      const report = await runSplit({
        root,
        paths: ["PostCard.tsx"],
        measure: false,
        noConfigFile: true,
        config: { minBytesSaved: 0 },
      });
      const [first] = report.files;
      const renamed = await report.rerun("PostCard.tsx", { PostCardButton: "LikeButton" });
      expect(renamed.status).toBe("split");
      expect(renamed.outputs["PostCard.client.tsx"]).toContain("export function LikeButton()");
      expect(renamed.outputs["PostCard.client.tsx"]).not.toMatch(/(?:^|[^\r])\n/);
      // The rewritten file matches the first run apart from the name: same bytes, same endings.
      expect(renamed.outputs["PostCard.tsx"]).toBe(
        first?.outputs["PostCard.tsx"]?.replaceAll("PostCardButton", "LikeButton"),
      );
      // The diff is still against the file as it is on disk, so only real changes show.
      expect(changedLines(renamed.diff)).toBe(changedLines(first?.diff ?? ""));
    }
  });

  it("keeps the original's line endings when the project's Prettier formats the output", async () => {
    const formatted = await prettier.format(POST_CARD, { parser: "typescript" });
    // Whatever the config's endOfLine, a CRLF file stays CRLF and an LF file stays LF.
    for (const endOfLine of ["lf", "crlf", "auto"]) {
      const config = { ".prettierrc.json": JSON.stringify({ endOfLine }) };
      const fromCrlf = await splitPostCard(crlf(formatted), config);
      expect(fromCrlf.server, endOfLine).not.toMatch(/(?:^|[^\r])\n/);
      expect(fromCrlf.island, endOfLine).not.toMatch(/(?:^|[^\r])\n/);
      const fromLf = await splitPostCard(formatted, config);
      expect(fromLf.server, endOfLine).not.toContain("\r");
      expect(fromLf.island, endOfLine).not.toContain("\r");
    }
  });

  it("formats only when the original is already formatted with the project's Prettier", async () => {
    const config = { ".prettierrc.json": "{}" };
    // POST_CARD's signature is longer than Prettier's printWidth (80).
    const formatted = await prettier.format(POST_CARD, { parser: "typescript" });
    expect(formatted).not.toBe(POST_CARD);

    const clean = await splitPostCard(formatted, config);
    expect(await prettier.check(clean.server, { parser: "typescript" })).toBe(true);
    expect(await prettier.check(clean.island, { parser: "typescript" })).toBe(true);

    // Not formatted: formatting would rewrite lines the split doesn't touch, so it doesn't run.
    const untouched = await splitPostCard(POST_CARD, config);
    const unformatted = await splitPostCard(POST_CARD);
    expect(untouched).toEqual(unformatted);
    expect(untouched.server).toContain(
      "export default function PostCard({ title, date }: { title: string; date: string }) {\n",
    );
  });
});
