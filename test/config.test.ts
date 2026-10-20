import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfigFile, loadConfigFileSync } from "../src/config/config.js";

const TMP = path.resolve(import.meta.dirname, ".tmp");
let dir = "";

function project(files: Record<string, string>): string {
  dir = path.join(TMP, `config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FULL = {
  include: ["src/**"],
  exclude: ["**/*.test.*"],
  clientOnlyPackages: ["my-ui/*"],
  serverSafeHooks: ["useTranslations"],
  clientFileSuffix: ".island",
  islandsDir: "_islands",
  minBytesSaved: 512,
  minStaticRatio: 0.6,
  prettier: false,
  mongoose: { autoSerialize: true },
};
const body = JSON.stringify(FULL);

describe("loadConfigFileSync (ESLint) matches loadConfigFile (CLI)", () => {
  const cases: [string, Record<string, string>][] = [
    ["json", { "auto-split.config.json": body }],
    [
      "ts with defineConfig and a typed import",
      {
        "auto-split.config.ts": `import { defineConfig } from "auto-server-split";
import type { UserConfig } from "auto-server-split";
const config: UserConfig = ${body};
export default defineConfig(config);
`,
      },
    ],
    [
      "mts importing a shared local module",
      {
        "shared.ts": `export const shared = ${body};\n`,
        "auto-split.config.mts": `import { shared } from "./shared";\nexport default { ...shared };\n`,
      },
    ],
    ["mjs", { "auto-split.config.mjs": `export default ${body};\n` }],
    ["js (ES module)", { "auto-split.config.js": `export default ${body};\n` }],
    [
      "js (CommonJS package)",
      {
        "package.json": `{ "type": "commonjs" }`,
        "auto-split.config.js": `module.exports = ${body};\n`,
      },
    ],
    [
      "mjs using import.meta",
      {
        "auto-split.config.mjs": `import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.basename(path.dirname(fileURLToPath(import.meta.url)));
const same = here === path.basename(import.meta.dirname) && import.meta.filename.endsWith(".mjs");
export default { ...${body}, include: [same ? "src/**" : here] };
`,
      },
    ],
    [
      "mjs importing an npm package",
      {
        "auto-split.config.mjs": `import { format } from "date-fns";
export default { ...${body}, include: [format(new Date(0), "'src'") + "/**"] };
`,
      },
    ],
  ];

  for (const [name, files] of cases) {
    it(name, async () => {
      const root = project(files);
      const file = path.join(
        root,
        Object.keys(files).find((f) => f.startsWith("auto-split.config")) as string,
      );
      const asyncResult = await loadConfigFile(file);
      expect(asyncResult).toEqual(FULL);
      expect(loadConfigFileSync(file)).toEqual(asyncResult);
    });
  }

  it("rejects the same invalid config with the same message", async () => {
    const file = path.join(
      project({ "auto-split.config.ts": `export default { minBytesSaved: -1, colour: "red" };\n` }),
      "auto-split.config.ts",
    );
    const asyncError = await loadConfigFile(file).catch((e: unknown) => e);
    expect(asyncError).toBeInstanceOf(ConfigError);
    expect(() => loadConfigFileSync(file)).toThrow((asyncError as Error).message);
  });

  it("rejects a config without a default export", async () => {
    const file = path.join(
      project({ "auto-split.config.mjs": `export const x = 1;\n` }),
      "auto-split.config.mjs",
    );
    await expect(loadConfigFile(file)).rejects.toThrow("the config must be an object");
    expect(() => loadConfigFileSync(file)).toThrow("the config must be an object");
  });

  it("rejects invalid JSON with a ConfigError in both", async () => {
    const file = path.join(
      project({ "auto-split.config.json": "{ nope" }),
      "auto-split.config.json",
    );
    await expect(loadConfigFile(file)).rejects.toThrow("invalid JSON");
    expect(() => loadConfigFileSync(file)).toThrow(ConfigError);
  });

  it("explains that top-level await can't be loaded synchronously", async () => {
    const file = path.join(
      project({
        "auto-split.config.mjs": `const value = await Promise.resolve(${body});\nexport default value;\n`,
      }),
      "auto-split.config.mjs",
    );
    expect(await loadConfigFile(file)).toEqual(FULL);
    expect(() => loadConfigFileSync(file)).toThrow(/couldn't be loaded synchronously for ESLint/);
  });
});
