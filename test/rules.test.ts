import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/config.js";
import { splitOne } from "./helpers.js";

/** A plain package (no React dependency) and a React package nobody has classified. */
const packages = {
  "node_modules/my-fmt/package.json": JSON.stringify({ name: "my-fmt", main: "index.js" }),
  "node_modules/my-fmt/index.js":
    "export const shout = (s) => s.toUpperCase();\nexport const money = (n) => `$${n}`;\nexport const today = () => new Date().toDateString();\n",
  "node_modules/my-fmt/index.d.ts":
    "export declare function shout(s: string): string;\nexport declare function money(n: number): string;\nexport declare function today(): string;\n",
  "node_modules/my-ui/package.json": JSON.stringify({
    name: "my-ui",
    main: "index.js",
    peerDependencies: { react: "*" },
  }),
  "node_modules/my-ui/index.js": "export const Icon = () => null;\n",
  "node_modules/my-ui/index.d.ts": "export declare function Icon(): null;\n",
};

const card = (imports: string, heading: string) => `"use client";
import { useState } from "react";
${imports}
export default function Card({ title, price }: { title: string; price: number }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
      <h2>${heading}</h2>
      <p>{price}</p>
      <button onClick={() => setOpen(!open)}>{String(open)}</button>
    </article>
  );
}
`;

const rootTags = (result: Awaited<ReturnType<typeof splitOne>>) =>
  result.islands.map((i) => i.rootTag);

describe("rules", () => {
  it("clientOnlyImports keeps one export of a package in islands", async () => {
    const source = card('import { shout } from "my-fmt";', "{shout(title)}");
    expect(rootTags(await splitOne(source, packages))).toEqual(["button"]);
    const ruled = await splitOne(source, packages, {
      rules: { clientOnlyImports: ["my-fmt#shout"] },
    });
    expect(rootTags(ruled)).toEqual(["h2", "button"]);
  });

  it("serverSafeExports lets one export of an unknown React package render on the server", async () => {
    const source = card('import { Icon } from "my-ui";', "<Icon />{title}");
    expect(rootTags(await splitOne(source, packages))).toEqual(["Icon", "button"]);
    const ruled = await splitOne(source, packages, {
      rules: { serverSafeExports: ["my-ui#Icon"] },
    });
    expect(rootTags(ruled)).toEqual(["button"]);
  });

  it("browserDependentCalls keeps a call in an island, like Date.now()", async () => {
    const source = card('import { today } from "my-fmt";', "{title} {today()}");
    expect(rootTags(await splitOne(source, packages))).toEqual(["button"]);
    const ruled = await splitOne(source, packages, {
      rules: { browserDependentCalls: ["my-fmt#today"] },
    });
    expect(rootTags(ruled)).toEqual(["h2", "button"]);
  });

  it("matches global calls by their path", async () => {
    const source = card("", "{title} {performance.timeOrigin.toFixed()}");
    const ruled = await splitOne(
      source,
      {},
      {
        rules: { browserDependentCalls: ["performance.timeOrigin.toFixed"] },
      },
    );
    expect(rootTags(ruled)).toEqual(["h2", "button"]);
  });

  it("warnings report a named call that moves to the server", async () => {
    const result = await splitOne(
      card('import { money } from "my-fmt";', "{title} {money(price)}"),
      packages,
      {
        rules: {
          warnings: [{ call: "my-fmt#money", message: "it formats in the server's locale" }],
        },
      },
    );
    expect(result.status).toBe("split");
    expect(result.warnings).toEqual([
      {
        code: "rule",
        message: "money() from my-fmt now runs on the server: it formats in the server's locale",
        location: { line: 8, column: 20 },
      },
    ]);
  });

  it("validates entries", () => {
    expect(() => validateConfig({ rules: { colour: [] } }, "test")).toThrow(
      /"rules" has an unknown key "colour"/,
    );
    expect(() => validateConfig({ rules: { clientOnlyImports: ["a#b#c"] } }, "test")).toThrow(
      /invalid entry "a#b#c"/,
    );
    expect(() => validateConfig({ rules: { warnings: [{ call: "x" }] } }, "test")).toThrow(
      /warnings must be an array of \{ call: string, message: string \}/,
    );
  });
});
