import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModuleSafety } from "../../src/analysis/moduleSafety.js";
import { nextAdapter } from "../../src/frameworks/next.js";
import { loadProject } from "../../src/project/loadProject.js";
import { buildModuleGraph } from "../../src/project/moduleGraph.js";
import { PackageClassifier } from "../../src/project/packages.js";
import { selfCheck } from "../../src/verify/selfCheck.js";

const fixture = path.resolve(import.meta.dirname, "../fixtures/01-postcard-like-button");
const file = path.join(fixture, "input/PostCard.tsx");
const islandFile = path.join(fixture, "input/PostCard.client.tsx");
const goodServer = readFileSync(path.join(fixture, "output/PostCard.tsx"), "utf8");
const goodIsland = readFileSync(path.join(fixture, "output/PostCard.client.tsx"), "utf8");

const loaded = loadProject(path.join(fixture, "input"));
const classifier = new PackageClassifier(nextAdapter, []);
const graph = buildModuleGraph(loaded, classifier);
const moduleSafety = new ModuleSafety(
  () => loaded.project.getProgram().compilerObject,
  graph,
  nextAdapter,
  new Set(),
);

function run(serverText: string, islandText: string) {
  return selfCheck({
    loaded,
    graph,
    framework: nextAdapter,
    classifier,
    moduleSafety,
    serverSafeHooks: new Set(),
    file,
    islandFile,
    islandSpecifier: "./PostCard.client",
    serverText,
    islandText,
    importers: [path.join(fixture, "input/app/page.tsx")],
    isJs: false,
  });
}

describe("selfCheck", () => {
  it("accepts the expected PostCard output", () => {
    expect(run(goodServer, goodIsland)).toEqual({ ok: true, value: undefined });
  });

  it("restores the project afterwards", () => {
    run(goodServer, goodIsland);
    expect(loaded.project.getSourceFile(file)?.getFullText()).toBe(readFileSync(file, "utf8"));
    expect(loaded.project.getSourceFile(islandFile)).toBeUndefined();
  });

  it("rejects output that doesn't parse", () => {
    const result = run(goodServer, goodIsland.replace("return <button", "return <<button"));
    expect(result).toMatchObject({ ok: false, skip: { code: "self-check-failed" } });
  });

  it("rejects output with new type errors", () => {
    const result = run(
      goodServer,
      goodIsland.replace("useState(false);", "useState(false);\n  const n: number = liked;"),
    );
    expect(result).toMatchObject({
      ok: false,
      skip: { code: "self-check-failed", message: expect.stringContaining("new errors") },
    });
  });

  it("rejects a server file that still uses client-only code", () => {
    const server = goodServer
      .replace(
        'import { PostCardButton } from "./PostCard.client";',
        'import { PostCardButton } from "./PostCard.client";\nimport { useState } from "react";',
      )
      .replace("  return (\n", "  const [x] = useState(0);\n  return (\n")
      .replace("<PostCardButton />", "<PostCardButton />{x}");
    const result = run(server, goodIsland);
    expect(result).toMatchObject({
      ok: false,
      skip: { code: "self-check-failed", message: expect.stringContaining("client-only") },
    });
  });

  it("rejects a server file that still has an event handler", () => {
    const result = run(
      goodServer.replace("<h2>{post.title}</h2>", "<h2 onClick={() => {}}>{post.title}</h2>"),
      goodIsland,
    );
    expect(result).toMatchObject({ ok: false, skip: { code: "self-check-failed" } });
  });

  it("rejects a non-serializable island prop", () => {
    const server = goodServer.replace(
      "<PostCardButton />",
      "<PostCardButton format={(s: string) => s} />",
    );
    const island = goodIsland.replace(
      "export function PostCardButton() {",
      "export function PostCardButton({ format }: { format: (s: string) => string }) {",
    );
    const result = run(server, island);
    expect(result).toMatchObject({
      ok: false,
      skip: { code: "self-check-failed", message: expect.stringContaining("function") },
    });
  });

  it("rejects an island that imports server-only modules", () => {
    const island = goodIsland.replace(
      'import { useState } from "react";',
      'import { useState } from "react";\nimport { cookies } from "next/headers";\nvoid cookies;',
    );
    const result = run(goodServer, island);
    expect(result).toMatchObject({
      ok: false,
      skip: {
        code: "self-check-failed",
        message: expect.stringContaining("server-only module next/headers"),
      },
    });
  });
});
