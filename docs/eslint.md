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

It runs the same engine as the CLI with the same config file, then the same self-check and the
same size measurement, so it only reports files that `npx auto-server-split <file>` would split.

Options:

| Option           | Default | Meaning                                                                                                                                                                               |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minStaticRatio` | `0.5`   | Report only when at least this share of the JSX would stay on the server. The config's `minStaticRatio` (default 0.3) always applies too, so this can raise the bar but not lower it. |
| `selfCheck`      | `true`  | Run the in-memory self-check before reporting (turn off for speed).                                                                                                                   |
| `measure`        | `true`  | Measure the saving with esbuild and apply the config's `minBytesSaved`, as the CLI does. `false` skips both, like `--no-measure`.                                                     |

Turning off `selfCheck` or `measure` trades accuracy for speed: the rule may then report a file the
CLI skips.

**No autofix.** ESLint fixes can only edit the linted file, and a split creates a new one. Run the
CLI to apply the split.

### Typed and untyped linting

- With typed linting (`parserOptions.project` / `projectService`), the rule loads the full project
  for the program's tsconfig, exactly as the CLI does.
- Without it, the rule finds the nearest `tsconfig.json`/`jsconfig.json`, builds the module graph
  syntactically (the tsconfig's files plus the files they import, as TypeScript's own program
  does: imported `.js`/`.jsx` files count only with `allowJs`), and loads only the linted file,
  what it imports, and its importers. If it can't verify every importer, it doesn't report.

Both are cached per tsconfig for the lifetime of the ESLint process. The linted file's editor
contents are analysed and measured, not the file on disk, but the module graph is built once per
process from the files on disk. An import added since then, in the linted file or in another file,
isn't seen until the process restarts: `npx eslint` always starts fresh, while an editor's ESLint
server keeps running until you restart it. In the linted file, a module imported only in unsaved
text is treated as client-only, so the rule may stay silent until then.

### Configuration

The rule reads the config file the CLI would find in the project root (the directory of the
tsconfig): `auto-split.config.{ts,mts,mjs,js,json}`. ESLint rules are synchronous, so non-JSON
configs are bundled with esbuild and evaluated in place. A config that uses top-level await can't
be loaded this way and is reported as an error, as is an invalid config. The config is read once
per ESLint process; restart the ESLint server after changing it. `--config <file>` is a CLI flag the
rule doesn't see.
