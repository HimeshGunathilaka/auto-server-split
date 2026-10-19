import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "eslint/index": "src/eslint/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: { entry: { index: "src/index.ts", "eslint/index": "src/eslint/index.ts" } },
  clean: true,
  sourcemap: true,
  splitting: true,
  define: { __VERSION__: JSON.stringify(version) },
});
