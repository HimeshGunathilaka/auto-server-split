import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findAppRoutes } from "../src/frameworks/next.js";
import { SnapshotError, split } from "../src/index.js";
import { parseAnalyzerExport } from "../src/measure/nextAnalyze.js";
import type { View } from "../src/measure/routes.js";
import { routeModules } from "../src/measure/routes.js";
import type { ModuleEdge } from "../src/project/moduleTypes.js";

const tmp = path.join(import.meta.dirname, ".tmp", `routes-${process.pid}`);
const write = (dir: string, files: Record<string, string>) => {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return realpathSync(dir);
};
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const page = "export default function Page() { return null; }\n";

describe("findAppRoutes", () => {
  it("finds pages with the files that wrap them", () => {
    const root = write(path.join(tmp, "find"), {
      "app/layout.tsx": page,
      "app/page.tsx": page,
      "app/(shop)/layout.tsx": page,
      "app/(shop)/cart/page.tsx": page,
      "app/blog/[slug]/loading.tsx": page,
      "app/blog/[slug]/page.tsx": page,
      "app/@modal/(.)photo/page.tsx": page,
      "app/_components/page.tsx": page,
      "app/api/route.ts": "export async function GET() { return new Response(); }\n",
    });
    const routes = findAppRoutes(root, ["tsx", "ts"]).map((r) => ({
      route: r.route,
      entries: r.entries.map((e) => path.relative(root, e)),
    }));
    expect(routes).toEqual([
      { route: "/", entries: ["app/layout.tsx", "app/page.tsx"] },
      {
        route: "/blog/[slug]",
        entries: ["app/layout.tsx", "app/blog/[slug]/loading.tsx", "app/blog/[slug]/page.tsx"],
      },
      {
        route: "/cart",
        entries: ["app/layout.tsx", "app/(shop)/layout.tsx", "app/(shop)/cart/page.tsx"],
      },
    ]);
  });
});

describe("routeModules", () => {
  const edge = (from: string, to: string, kind: ModuleEdge["kind"] = "static"): ModuleEdge => ({
    from,
    to,
    kind,
    specifier: to,
    external: undefined,
    line: 1,
  });
  const pkg = (from: string, name: string): ModuleEdge => ({
    from,
    to: undefined,
    kind: "static",
    specifier: name,
    external: { specifier: name, packageName: name, kind: "neutral" },
    line: 1,
  });
  const view = (
    nodes: Record<string, { directive?: "use client" | "use server"; edges: ModuleEdge[] }>,
  ): View => ({
    directive: (f) => nodes[f]?.directive,
    edges: (f) => nodes[f]?.edges ?? [],
  });

  it("separates what a route loads with the page from what it loads later", () => {
    const modules = routeModules(
      "/r",
      view({
        "/r/app/page.tsx": {
          edges: [
            edge("/r/app/page.tsx", "/r/Card.tsx"),
            edge("/r/app/page.tsx", "/r/Chart.tsx", "dynamic"),
          ],
        },
        "/r/Card.tsx": {
          directive: "use client",
          edges: [pkg("/r/Card.tsx", "marked"), edge("/r/Card.tsx", "/r/actions.ts")],
        },
        "/r/actions.ts": { directive: "use server", edges: [pkg("/r/actions.ts", "pg")] },
        "/r/Chart.tsx": {
          directive: "use client",
          edges: [
            pkg("/r/Chart.tsx", "recharts"),
            edge("/r/Chart.tsx", "/r/Legend.tsx", "dynamic"),
          ],
        },
        "/r/Legend.tsx": { directive: "use client", edges: [pkg("/r/Legend.tsx", "d3")] },
      }),
      ["/r/app/page.tsx"],
    );
    expect([...modules.initial].sort()).toEqual(["Card.tsx", "marked"]);
    expect([...modules.lazy].sort()).toEqual(["Chart.tsx", "Legend.tsx", "d3", "recharts"]);
  });
});

describe("parseAnalyzerExport", () => {
  it("attributes client bytes per route to project files and packages", () => {
    // Turbopack's root is the monorepo; the project is apps/web inside it.
    const repo = write(path.join(tmp, "snapshot"), {
      "apps/web/components/Card.tsx": page,
      "apps/web/app/page.tsx": page,
    });
    const root = path.join(repo, "apps/web");
    const lines = [
      {
        type: "meta",
        schema_version: 1,
        snapshot_name: "before",
        module_index_hash: "x",
        route_count: 1,
        selected_routes: 1,
      },
      { type: "route", route: "/", entries: [], coverage: { entries: "exact", groups: "exact" } },
      {
        type: "group",
        route: "/",
        id: 0,
        kind: "bootstrap",
        trigger_module_ident: null,
        trigger_join: "none",
        outputs: ["[client-fs]/_next/static/chunks/a.js"],
      },
      {
        type: "group",
        route: "/",
        id: 1,
        kind: "async",
        trigger_module_ident: null,
        trigger_join: "none",
        outputs: ["[client-fs]/_next/static/chunks/b.js"],
      },
      {
        type: "part",
        route: "/",
        filename: "[client-fs]/_next/static/chunks/a.js",
        source_path: "[project]/apps/web/components/Card.tsx",
        size: 900,
        compressed_size: 300,
      },
      {
        type: "part",
        route: "/",
        filename: "[client-fs]/_next/static/chunks/a.js",
        source_path:
          "[project]/node_modules/.pnpm/marked@18.1.1/node_modules/marked/lib/marked.esm.js",
        size: 45000,
        compressed_size: 13000,
      },
      {
        type: "part",
        route: "/",
        filename: "[client-fs]/_next/static/chunks/b.js",
        source_path: "[project]/node_modules/.pnpm/marked@18.1.1/node_modules/marked/lib/extra.js",
        size: 300,
        compressed_size: 100,
      },
      {
        type: "part",
        route: "/",
        filename: "[client-fs]/_next/static/chunks/a.css",
        source_path: "[project]/apps/web/app/globals.css",
        size: 50,
        compressed_size: 40,
      },
      {
        type: "part",
        route: "/",
        filename: "[project]/apps/web/.next/server/app/page.js",
        source_path: "[project]/apps/web/app/page.tsx",
        size: 500,
        compressed_size: 200,
      },
    ];
    const snapshot = parseAnalyzerExport(lines.map((l) => JSON.stringify(l)).join("\n"), root);
    expect("error" in snapshot).toBe(false);
    if ("error" in snapshot) return;
    const route = snapshot.routes.get("/");
    expect(route && Object.fromEntries(route.initial)).toEqual({
      "components/Card.tsx": 300,
      marked: 13000,
    });
    expect(route && Object.fromEntries(route.lazy)).toEqual({ marked: 100 });
    expect(route?.initialBytes).toBe(13300);
  });

  it("rejects what isn't analyzer output", () => {
    expect(parseAnalyzerExport('{"type":"part"}\n', tmp)).toEqual({
      error: "no meta record; is this `next analyze export` output?",
    });
    expect(parseAnalyzerExport("not json\n", tmp)).toEqual({ error: "line 1 isn't JSON" });
  });
});

describe("split() routes", () => {
  it("counts a package's Client Component the server still renders as shipped", async () => {
    // ~20 KB of code that doesn't compress away.
    let seed = 1;
    const noise = Array.from({ length: 20_000 }, () => {
      seed = (seed * 48271) % 2147483647;
      return String.fromCharCode(97 + (seed % 26));
    }).join("");
    const root = write(path.join(tmp, "client-entry"), {
      "app/page.tsx": `import Shell from "../components/Shell";
export default function Page() {
  return <Shell title="Hi" />;
}
`,
      "components/Shell.tsx": `"use client";
import { Toaster } from "toastkit";
import { useState } from "react";

export default function Shell({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>{title}</h1>
      <Toaster position="top" />
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </main>
  );
}
`,
      "node_modules/toastkit/package.json": JSON.stringify({
        name: "toastkit",
        main: "index.js",
        peerDependencies: { react: "*" },
      }),
      "node_modules/toastkit/index.js": `"use client";\nexport const blob = "${noise}";\nexport function Toaster() { return blob.length > 0 ? null : null; }\n`,
      "node_modules/toastkit/index.d.ts":
        "export declare function Toaster(props: { position: string }): null;\n",
    });
    const result = await split({ root, noConfigFile: true, config: { minBytesSaved: 0 } });
    const shell = result.files.find((f) => f.file === "components/Shell.tsx");
    expect(shell?.status).toBe("split");
    expect(shell?.outputs["components/Shell.tsx"]).toContain('<Toaster position="top" />');
    // toastkit still ships (the Server Component renders <Toaster>), so it isn't a saving.
    expect(shell?.bytesSaved?.conservative).toBeLessThan(2000);
    expect(shell?.routes?.[0]?.bytesSaved).toBeLessThan(2000);
  });

  it("reports the routes a split affects and what it saves there", async () => {
    // Inside the repository, so react, next and marked resolve from its node_modules.
    const root = write(path.join(tmp, "app"), {
      "app/layout.tsx": `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx": `import PostCard from "../components/PostCard";
export default function Page() {
  return <PostCard body="**hi**" />;
}
`,
      "app/about/page.tsx": `export default function About() {
  return <p>About</p>;
}
`,
      "components/PostCard.tsx": `"use client";
import { marked } from "marked";
import { useState } from "react";

export default function PostCard({ body }: { body: string }) {
  const [liked, setLiked] = useState(false);
  return (
    <article>
      <div dangerouslySetInnerHTML={{ __html: marked(body) as string }} />
      <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>
    </article>
  );
}
`,
    });
    const result = await split({ root, noConfigFile: true, config: { minBytesSaved: 0 } });
    const card = result.files.find((f) => f.file === "components/PostCard.tsx");
    expect(card?.status).toBe("split");
    expect(card?.routes).toEqual([{ route: "/", load: "initial", bytesSaved: expect.any(Number) }]);
    expect(card?.routes?.[0]?.bytesSaved).toBeGreaterThan(5000);
    expect(result.routes).toEqual([
      {
        route: "/",
        files: ["components/PostCard.tsx"],
        initialSaved: card?.routes?.[0]?.bytesSaved,
        lazySaved: 0,
        source: "esbuild",
      },
    ]);
    const unmeasured = await split({
      root,
      noConfigFile: true,
      measure: false,
      config: { minBytesSaved: 0 },
    });
    expect(unmeasured.files[0]?.routes).toEqual([{ route: "/", load: "initial" }]);
    expect(unmeasured.routes).toEqual([{ route: "/", files: ["components/PostCard.tsx"] }]);
  });

  it("refuses an analyzer snapshot of another project", async () => {
    const root = write(path.join(tmp, "other"), {
      "app/page.tsx": page,
      "snapshot.jsonl": [
        { type: "meta", schema_version: 1, snapshot_name: "x", route_count: 1 },
        { type: "route", route: "/", entries: [], coverage: { entries: "exact", groups: "exact" } },
        {
          type: "group",
          route: "/",
          id: 0,
          kind: "bootstrap",
          outputs: ["[client-fs]/_next/static/chunks/a.js"],
        },
        {
          type: "part",
          route: "/",
          filename: "[client-fs]/_next/static/chunks/a.js",
          source_path: "[project]/components/ElsewhereCard.tsx",
          size: 900,
          compressed_size: 300,
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    });
    const run = split({ root, noConfigFile: true, analyzeSnapshot: "snapshot.jsonl" });
    await expect(run).rejects.toThrow(SnapshotError);
    await expect(
      split({ root, noConfigFile: true, analyzeSnapshot: "snapshot.jsonl" }),
    ).rejects.toThrow("describes another project");
  });
});
