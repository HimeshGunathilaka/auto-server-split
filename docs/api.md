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
  measureError?: string; // why bytesSaved is missing although measuring was on (only with minBytesSaved: 0)
  diff: string; // unified diff for every touched/created file
  outputs: Record<string, string>; // relative path -> new content
};
```

`bytesSaved.isolated` is the gzip size of the original file's bundle minus the island's.
`bytesSaved.conservative` also leaves out code that other client modules still import, because the
browser downloads it anyway. Thresholds and the CLI summary use `conservative`.

With measuring on, every split has `bytesSaved`, except when esbuild can't bundle the file: then
the file is skipped as `measure-failed`, or, with `minBytesSaved: 0`, split with `measureError` set.

`npx auto-server-split --json` prints the same `{ files }` object. One split and one skip
(`diff` and `outputs` shortened):

```json
{
  "files": [
    {
      "file": "components/ArticleFooter.tsx",
      "status": "split",
      "islands": [{ "name": "ArticleFooterButton", "rootTag": "button", "props": [], "line": 11 }],
      "staticRatio": 0.8333333333333334,
      "bytesSaved": { "isolated": 83, "conservative": 83 },
      "diff": "===…\n--- a/components/ArticleFooter.tsx\n+++ b/components/ArticleFooter.tsx\n…",
      "outputs": {
        "components/ArticleFooter.tsx": "import { ArticleFooterButton } from \"./ArticleFooter.client\";\n…",
        "components/ArticleFooter.client.tsx": "\"use client\";\n\nexport function ArticleFooterButton() {…"
      }
    },
    {
      "file": "components/Banner.tsx",
      "status": "skipped",
      "islands": [],
      "staticRatio": 0,
      "diff": "",
      "outputs": {},
      "skipped": {
        "code": "state-spans-component",
        "message": "client state is used across the whole returned tree (<div>, <small>)",
        "location": { "line": 6, "column": 5 }
      }
    }
  ]
}
```

Only files that start with `"use client"` appear in `files`, and each is either `"split"` or
`"skipped"`; `"unchanged"` is part of the type but isn't produced by this version. Unexpected errors are reported per file
as `internal-error` and never reject the promise. Invalid configuration rejects with a `ConfigError`.

## `SKIP_CODES` and `SKIP_TITLES`

`SKIP_CODES` is the list of every `SkipCode`. `SKIP_TITLES` maps each code to the short title the
CLI summary prints (for example `state-spans-component` → "client state spans the whole
component"). [skip-reasons.md](skip-reasons.md) explains each code.

## `defineConfig(config: UserConfig): UserConfig`

Identity function that gives `auto-split.config.ts` type checking.
