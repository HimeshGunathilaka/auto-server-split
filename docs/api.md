# API

```ts
import { split, defineConfig, SKIP_CODES, SKIP_TITLES } from "auto-server-split";
import type {
  SplitOptions,
  SplitResult,
  FileResult,
  SkipCode,
  UserConfig,
} from "auto-server-split";
```

## `split(options?: SplitOptions): Promise<SplitResult>`

| Option         | Type                           | Default          | Meaning                                                                                                                                            |
| -------------- | ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`         | `string`                       | `process.cwd()`  | Project root (where `tsconfig.json`/`jsconfig.json` lives). Without one, Next.js defaults are used and every source file under the root is loaded. |
| `paths`        | `string[]`                     | config `include` | Files or directories to consider, relative to `root`.                                                                                              |
| `write`        | `boolean`                      | `false`          | Write the outputs. The API doesn't check git state; the CLI does.                                                                                  |
| `config`       | `UserConfig`                   | `{}`             | Overrides the config file.                                                                                                                         |
| `configFile`   | `string`                       | auto             | Config file path relative to `root`.                                                                                                               |
| `noConfigFile` | `boolean`                      | `false`          | Ignore config files on disk.                                                                                                                       |
| `measure`      | `boolean`                      | `true`           | Run the esbuild size measurement. When `false`, `bytesSaved` is omitted and `minBytesSaved` isn't applied.                                         |
| `onFile`       | `(result: FileResult) => void` |                  | Called as soon as each file is done.                                                                                                               |

```ts
type SplitResult = { files: FileResult[] };

type FileResult = {
  file: string; // relative to root
  status: "split" | "skipped" | "unchanged";
  skipped?: { code: SkipCode; message: string; location?: { line: number; column: number } };
  islands: Array<{
    name: string; // e.g. "PostCardButton"
    rootTag: string; // e.g. "button", "motion.div", "Accordion"
    props: string[]; // props passed from the server (including "children"/"slotN" for donut slots)
    line: number;
    moved?: boolean; // a whole helper component moved into the island file
  }>;
  staticRatio: number; // share of JSX nodes that stay on the server, 0..1
  bytesSaved?: { isolated: number; conservative: number }; // gzip bytes
  diff: string; // unified diff for every touched/created file
  outputs: Record<string, string>; // relative path -> new content
};
```

Only files that start with `"use client"` appear in `files`, and each is either `"split"` or
`"skipped"`; `"unchanged"` is part of the type but isn't produced by this version. Unexpected errors are reported per file
as `internal-error` and never reject the promise. Invalid configuration rejects with a `ConfigError`.

## `defineConfig(config: UserConfig): UserConfig`

Identity function that gives `auto-split.config.ts` type checking.
