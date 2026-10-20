# Configuration

`auto-split.config.ts`, `.mts`, `.mjs`, `.js` or `.json` in the project root (or `--config <file>`).
Options passed to the API (`split({ config })`) override the file.

| Key                      | Type              | Default                                            | Meaning                                                                                                                                      |
| ------------------------ | ----------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`                | `string[]`        | `["app/**", "components/**", "src/**"]`            | Globs scanned when no paths are given.                                                                                                       |
| `exclude`                | `string[]`        | `["**/*.test.*", "**/*.spec.*", "**/*.stories.*"]` | Globs never touched.                                                                                                                         |
| `clientOnlyPackages`     | `string[]`        | `[]`                                               | Extra packages whose exports are client-only (`"@scope/*"` matches a scope). Added to the built-in list in `src/analysis/clientPackages.ts`. |
| `serverSafeHooks`        | `string[]`        | `[]`                                               | Hook names that work in Server Components and must not be treated as client-only (e.g. `useTranslations` with next-intl).                    |
| `clientFileSuffix`       | `string`          | `".client"`                                        | `PostCard.tsx` → `PostCard.client.tsx`.                                                                                                      |
| `islandsDir`             | `string`          | —                                                  | Put island files in a subdirectory (`components/_islands/PostCard.client.tsx`). Relative imports are rebased.                                |
| `minBytesSaved`          | `number`          | `2048`                                             | Skip splits whose conservative gzip saving is smaller (`below-threshold`), or can't be measured (`measure-failed`).                          |
| `minStaticRatio`         | `number`          | `0.3`                                              | Skip splits that keep a smaller share of the JSX on the server.                                                                              |
| `prettier`               | `"auto" \| false` | `"auto"`                                           | Format touched/generated files with the project's own Prettier, if it has a Prettier config inside the project root.                         |
| `mongoose.autoSerialize` | `boolean`         | `false`                                            | Pass only the fields an island reads from Mongoose documents / ObjectId-bearing values (`String()` for ObjectIds).                           |

Unknown keys and invalid values are reported together, for example:

```
auto-split.config.json:
  - unknown key "colour" (allowed: include, exclude, …)
  - "minBytesSaved" must be a non-negative number
```

`.ts`/`.mts` configs are compiled with esbuild. `import { defineConfig } from "auto-server-split"` works
without the package being resolvable from the config's directory.

The ESLint rule reads the same file (any format, loaded synchronously), except a config that uses
top-level await, which it reports as an error. It doesn't see `--config`.
