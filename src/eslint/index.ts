import type { ESLint, Linter } from "eslint";
import { preferServerSplit } from "./rules/prefer-server-split.js";

declare const __VERSION__: string;

const plugin = {
  meta: {
    name: "auto-server-split",
    version: typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev",
  },
  rules: { "prefer-server-split": preferServerSplit },
  configs: {} as { recommended: Linter.Config },
} satisfies ESLint.Plugin;

plugin.configs.recommended = {
  name: "auto-server-split/recommended",
  plugins: { "auto-server-split": plugin },
  rules: { "auto-server-split/prefer-server-split": ["warn", { minStaticRatio: 0.5 }] },
};

export default plugin;
