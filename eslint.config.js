import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "test/fixtures/**",
      "test/eslint-project/**",
      "test/eslint-directive-project/**",
      "e2e/apps/**",
      "e2e/.tmp/**",
      "coverage/**",
      "test/.tmp/**",
    ],
  },
  js.configs.recommended,
  { files: ["**/*.mjs", "**/*.js"], languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
