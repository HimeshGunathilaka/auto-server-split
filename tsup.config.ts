import { defineConfig } from "tsup";

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
  banner: ({ format }) => (format === "esm" ? {} : {}),
});
