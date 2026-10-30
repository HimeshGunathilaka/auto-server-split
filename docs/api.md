# API

```ts
import {
  split,
  explain,
  defineConfig,
  ConfigError,
  SnapshotError,
  SKIP_CODES,
  SKIP_TITLES,
  WARNING_CODES,
} from "auto-server-split";
import type {
  SplitOptions,
  SplitResult,
  FileResult,
  RouteSaving,
  RunSummary,
  Explanation,
  SkipCode,
  UserConfig,
} from "auto-server-split";
```

## `split(options?: SplitOptions): Promise<SplitResult>`

| Option            | Type                           | Default          | Meaning                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root`            | `string`                       | `process.cwd()`  | Project root (where `tsconfig.json`/`jsconfig.json` lives). Without one, Next.js defaults are used and every source file under the root is loaded.                                                                                                                                                                                                                                     |
| `paths`           | `string[]`                     | config `include` | Files or directories to consider, relative to `root`.                                                                                                                                                                                                                                                                                                                                  |
| `only`            | `string[]`                     |                  | Narrows the targets (from `paths` or `include`) to these files, relative to `root`. The CLI's `--since` passes the files changed since a git ref.                                                                                                                                                                                                                                      |
| `baseline`        | `string[]`                     |                  | Files to leave as they are, relative to `root`: not analysed, and size estimates don't assume they're split. The CLI's `--baseline` reads them from a file.                                                                                                                                                                                                                            |
| `write`           | `boolean`                      | `false`          | Write the outputs. The API doesn't check git state; the CLI does.                                                                                                                                                                                                                                                                                                                      |
| `config`          | `UserConfig`                   | `{}`             | Overrides the config file. Validated like a config file: unknown keys and invalid values reject with a `ConfigError`.                                                                                                                                                                                                                                                                  |
| `configFile`      | `string`                       | auto             | Config file path relative to `root`.                                                                                                                                                                                                                                                                                                                                                   |
| `noConfigFile`    | `boolean`                      | `false`          | Ignore config files on disk.                                                                                                                                                                                                                                                                                                                                                           |
| `measure`         | `boolean`                      | `true`           | Run the esbuild size measurement. When `false`, `bytesSaved` is omitted and `minBytesSaved` isn't applied.                                                                                                                                                                                                                                                                             |
| `iterate`         | `boolean`                      | `true`           | Repeat the analysis until nothing new can change (see [Passes](#passes)). `false` makes one pass.                                                                                                                                                                                                                                                                                      |
| `onFile`          | `(result: FileResult) => void` |                  | Called as soon as each file is done. Changes are done only after every pass, since savings are estimated together; skips are reported as they're found.                                                                                                                                                                                                                                |
| `routes`          | `boolean`                      | `true`           | Work out which App Router routes each change affects (see [Routes](#routes)).                                                                                                                                                                                                                                                                                                          |
| `analyzeSnapshot` | `string`                       |                  | A Next.js analyzer snapshot to take route sizes from: the JSON Lines `next analyze export` prints, or a directory (the app, its `.next`, or `.next/diagnostics/analyze`) whose latest saved snapshot is exported with the project's own `next`. Rejects with a `SnapshotError` when it can't be read, or when it describes another project (none of its source files are in this one). |

```ts
type SplitResult = {
  files: FileResult[];
  routes?: RouteSaving[]; // per App Router route (see Routes)
  summary: RunSummary; // the run's numbers
};

type FileResult = {
  file: string; // relative to root
  status: "split" | "directive-removed" | "skipped" | "unchanged";
  fingerprint?: string; // on changes: identifies the change without its path or lines
  skipped?: { code: SkipCode; message: string; location?: { line: number; column: number } };
  islands: Array<{
    name: string; // e.g. "PostCardButton"
    rootTag: string; // e.g. "button", "motion.div", "Accordion"
    props: string[]; // props passed from the server (including "children"/"slotN" for donut slots)
    line: number;
    moved?: boolean; // a whole helper component moved into the island file
    effects?: boolean; // renders nothing, runs effects no element uses (rootTag "effects")
  }>;
  staticRatio: number; // share of JSX nodes that stay on the server, 0..1
  bytesSaved?: { isolated: number; conservative: number; sharedWith?: string[] }; // gzip bytes
  measureError?: string; // why bytesSaved is missing although measuring was on (only with minBytesSaved: 0)
  warnings?: Array<{
    code: WarningCode;
    message: string;
    location?: { line: number; column: number };
  }>; // on changes only
  requires?: string[]; // changes a later pass found this one after; apply them in the same run
  routes?: Array<{
    route: string; // "/", "/blog/[slug]"
    load: "initial" | "lazy"; // loaded with the page, or later (next/dynamic, import())
    bytesSaved?: number; // gzip bytes this change saves on the route (when measuring)
  }>;
  diff: string; // unified diff for every touched/created file
  outputs: Record<string, string>; // relative path -> new content
};
```

`bytesSaved.isolated` is the gzip size of the original file's bundle minus the island's.
`bytesSaved.conservative` assumes every split the tool proposes for the project is applied (this
run's and those of the other `"use client"` files in `include`, whatever `paths` you pass). It
leaves out code that other client modules would still import, because the browser downloads it
anyway, and divides code that several splits remove together between them, so the splits'
estimates add up to the total. `sharedWith` lists those other splits (relative paths); the saving
depends on applying them too. Thresholds and the CLI summary use `conservative`.

With measuring on, every split has `bytesSaved`, except when esbuild can't bundle the file: then
the file is skipped as `measure-failed`, or, with `minBytesSaved: 0`, split with `measureError` set.
A removed directive always gets `bytesSaved` or `measureError`: thresholds don't apply to it.

`npx auto-server-split --json` prints the same `{ files, routes, summary }` object. One split and one skip
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
        "message": "client-only code is used across the whole returned tree (<div>, <small>: reads wide)",
        "location": { "line": 6, "column": 5 }
      }
    }
  ]
}
```

Only files that start with `"use client"` appear in `files`, and each is `"split"`,
`"directive-removed"` (with [`removeUnusedDirectives`](configuration.md#removeunuseddirectives): the
file has no client-only code and only loses its directive; `islands` is empty and `outputs` holds
just the file) or `"skipped"`. `"unchanged"` is part of the type but isn't produced by this
version. Unexpected errors are reported per file as `internal-error` and never reject the promise. Invalid configuration (in a config file or in the
`config` option) rejects with a `ConfigError`.

`fingerprint` is the kind of change, the main component, its islands' names and its components'
source (whitespace aside), hashed: it stays the same when the file moves or other code shifts it,
and changes when the islands or the components do. Baselines, SARIF (`partialFingerprints`), GitLab
reports and `compare` use it.

An island with `effects: true` holds client statements that no element uses and no island owns,
such as a `useEffect` that sets `document.title`. It renders `null` and is added as the last child
of the element the component returns, so its effects run after its siblings', where the component's
own effects ran before (see [decisions.md](decisions.md)).

## Routes

With an `app/` (or `src/app/`) directory, each change lists the App Router routes that load the
file, and `SplitResult.routes` sums them up per route:

```ts
type RouteSaving = {
  route: string;
  files: string[]; // this run's changes on the route
  initialSaved?: number; // gzip bytes the route stops loading with the page
  lazySaved?: number; // ...and later, in chunks next/dynamic or import() load
  initialBytes?: number; // the route's initial client JavaScript, from an analyzer snapshot
  source?: "next-analyze" | "esbuild";
};
```

A route's client modules are found by following its page and the `layout`, `template`, `error`,
`loading` and `not-found` files around it through Server Components until a `"use client"` module,
then everything that imports. A module a change removes from a route is one no remaining client
module on that route imports; a module several changes remove is divided between them. A route's
total subtracts the island files it loads instead, while each change's own saving on the route is
never below 0, so a change whose island outweighs what it removes makes the total smaller than the
per-change savings added up. Sizes are each module's share of the esbuild bundles
the estimate already builds, or, with `analyzeSnapshot`, the gzip bytes Next.js's analyzer
attributes to that module on that route (the island files themselves are always estimated). Like
`bytesSaved`, route savings assume the other proposed changes are applied too.

## `explain(options: SplitOptions & { file: string }): Promise<Explanation>`

Runs the same analysis as `split()` and explains one file (relative to `root`):

```ts
type Explanation = {
  file: string;
  kind: "client-boundary" | "client" | "server" | "outside-project";
  directive?: "use client" | "use server";
  clientChain?: string[]; // client code: the shortest import chain from the "use client" module
  renderedBy?: Array<{ file: string; line: number }>; // Server Components that render the boundary
  serverUse?: {
    // no directive: could a Server Component import it, as a whole and per export?
    safe: boolean;
    reason?: string;
    exports: Array<{ name: string; safe: boolean; reason?: string; clientReference?: boolean }>; // clientReference: a re-exported Client Component
  };
  result?: FileResult; // a "use client" file: the run's result
  components?: Array<{
    name: string;
    anchors: Array<{ element: string; line: number; reasons: string[] }>; // what needs the client
    steps: string[]; // how the islands were formed: merges, growth, slots, props
  }>;
  imports?: Array<{
    module: string; // package name or project path
    fate: "island" | "leaves-client" | "still-shipped" | "server-only";
  }>;
  suggestion?: string; // what to do about a skip
};
```

## `RunSummary`

`SplitResult.summary` (and the `summary` of `--json`): `filesScanned`, `useClientFiles`,
`changes` (`splits` + `directivesRemoved`), `islands`, `skipped`, `skippedByCode`, `bytesSaved`
(the changes together, when measured), `unmeasured`, `warnings` (count per code), `routes` (how
many are affected) and `bestRoute` (`{ route, initialSaved }`).

## Passes

A change can make another file changeable: a component that only a client component imports is
skipped as `imported-by-client`, but once that importer is split (and the component stays in its
server part) or loses its directive, the component can be split too. So `split()` analyses those
skipped files again, in a pass that sees the earlier passes' outputs in memory, until a pass
changes nothing (at most 10 passes). Nothing is written in between, so a dry run shows the whole
result. Each file is reported once, with its final result.

Passes only plan. Size estimates and `minBytesSaved` are applied once, to every pass's changes
together, so a component and the one that unblocked it share the code they both stop shipping (a
parent and child that both import `marked` pass the threshold together). A change found in a later
pass lists the earlier changes it needs in `requires` (the `"use client"` files that made its
importers client modules); apply them in the same run. When one of those is dropped (below
`minBytesSaved`), the change is dropped too and reported with its `imported-by-client` skip, whose
message names the change it needs.

The CLI's `--interactive` mode makes one pass (`iterate: false`), since you accept each change
separately and a rename re-runs that file alone; run it again for the rest.

## Warnings

A change can carry `warnings`: risks the tool reports without refusing the change. `WARNING_CODES`
lists the codes; like skip codes, they're stable.

- `timezone-dependent`: code that formats or reads a date in the local timezone used to run in the
  browser and now renders on the server: date-fns formatting and calendar functions (`format`,
  `formatISO`, `startOfDay`, `isSameDay`...), `.format()` on a dayjs or moment value without
  `.tz()`, `.utc()` or `.utcOffset()` earlier in the chain, and `Date`'s local getters
  (`getHours()`, `getDate()`, `toDateString()`...), including on optional values (`at?.getHours()`).
  A call to a function imported from another project file is followed (three calls deep) and warned
  at the call: `formatStamp() calls format() from date-fns (lib/dates.ts:4), ...`. The `getUTC*()`
  methods and date-fns-tz don't warn. Calls that read the current time (`formatDistanceToNow`,
  `isToday`, `dayjs()`, `.fromNow()`) don't get here: like `Date.now()`, they stay in islands. At
  most five per file; the last one counts the rest.
- `ignore-outside-header`: an `auto-server-split-ignore` comment that isn't in the file header (for
  example above the component, after the imports), so it doesn't apply.
- `rule`: a call named in the config's [`rules.warnings`](configuration.md#rules) runs on the
  server after the change; the message is yours. At most five per file.

## `SKIP_CODES` and `SKIP_TITLES`

`SKIP_CODES` is the list of every `SkipCode`. `SKIP_TITLES` maps each code to the short title the
CLI summary prints (for example `state-spans-component` → "client state spans the whole
component"). [skip-reasons.md](skip-reasons.md) explains each code.

## `defineConfig(config: UserConfig): UserConfig`

Identity function that gives `auto-split.config.ts` type checking.
