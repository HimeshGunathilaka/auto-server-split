# ESLint plugin

```js
// eslint.config.js
import tseslint from "typescript-eslint";
import autoSplit from "auto-server-split/eslint";

export default [
  ...tseslint.configs.recommended,
  autoSplit.configs.recommended, // { "auto-server-split/prefer-server-split": ["warn", { minStaticRatio: 0.5 }] }
];
```

## `auto-server-split/prefer-server-split`

Reports on the `"use client"` directive of files the CLI would split:

```
PostCard is 80% static with 1 interactive island (<button>). Run: npx auto-server-split app/blog/PostCard.tsx --write
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `minStaticRatio` | `0.5` | Report only when at least this share of the JSX would stay on the server. |
| `selfCheck` | `true` | Run the in-memory self-check before reporting (turn off for speed). |

**No autofix.** ESLint fixes can only edit the linted file, and a split creates a new one. Run the
CLI to apply the split.

### Typed and untyped linting

- With typed linting (`parserOptions.project` / `projectService`), the rule loads the full project
  for the program's tsconfig, exactly as the CLI does.
- Without it, the rule finds the nearest `tsconfig.json`/`jsconfig.json`, builds the module graph
  syntactically, and loads only the linted file, what it imports, and its importers. If it can't
  verify every importer, it doesn't report.

Both are cached per tsconfig for the lifetime of the ESLint process. The linted file's editor
contents are analysed, not the file on disk. The rule reads `auto-split.config.json`, but not
`.ts`/`.mjs` config files: ESLint rules are synchronous.
