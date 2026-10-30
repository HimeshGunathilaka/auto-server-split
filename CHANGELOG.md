# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 1.0.3 — explainability, routes, workspaces, more splits

Explaining and reporting:

- `--explain <file>` (API: `explain()`) explains one file:
  - for a module, the `"use client"` boundary and the shortest import chain that make it client code, and the Server Components that render the boundary;
  - for a module without a directive, whether a Server Component could import it, export by export;
  - for a `"use client"` file, why each element needs the client and how the islands were formed (shared state, the closest common element, `.map()` hoisting, reads outside an island, server-rendered slots, props crossing);
  - what happens to each import, and what to do about a skip, including a concrete extraction for context providers.
- `--graph` lists the client boundaries: who renders each, the modules and packages each pulls into the browser bundle, and `"use client"` barrels that re-export modules which don't need the directive.
- Route-aware savings. Each change lists the App Router routes that load it (`initial`, or `lazy` through `next/dynamic`/`import()`) and what it saves on each. `SplitResult.routes` totals it per route (island files included), the text summary names the route that saves the most, and the API option `routes: false` turns it off. It's computed from the module graph (page, layouts and boundary files, through Server Components to the client modules), with sizes from the esbuild bundles.
  - `--analyze-snapshot <path>` (API: `analyzeSnapshot`) takes route sizes from a Next.js analyzer snapshot instead: `next analyze export` output, or the app directory, whose latest snapshot is exported with the project's `next`.
  - On the blog e2e app, `/` is estimated at 19.7 KB (esbuild) and 21 KB (analyzer), and measured at 18.5 KB.
- New output formats:
  - `--format sarif` (GitHub code scanning, with fingerprints);
  - `--format gitlab` (Code Quality);
  - `--format html` (a self-contained report with filters, routes and diffs).
- `--output <file>` writes a report and still prints the text output.
- `--json` (and `split()`) adds `summary` (`RunSummary`: counts, skips by code, warnings by code, saving, routes) and `routes`, and each change gets a `fingerprint` that survives moves and line changes.
- `auto-server-split compare <before.json> <after.json>` lists new opportunities, applied ones, savings that moved and skips that changed. It has `--format markdown`, and `--fail-on-new` exits `2` when there are new opportunities.

CI:

- Baselines are now version 2: changes with fingerprints and savings, every `"use client"` file, and totals. A component that moves keeps matching its entry. Version 1 files still read.
- New `check` config sets what fails `--check`:
  - `minSaving` / `minRouteSaving`: only changes above a saving fail;
  - `maxRecoverable`: a budget for the total;
  - `maxNewBoundaries`: new `"use client"` files compared with the baseline.
    The summary says which rule failed.
- `auto-server-split verify` runs the config's `verify.commands` (type checker, tests, build) and reports exit codes, durations and output tails. It has `--json`, `--keep-going`, and `--report` to add the result to a JSON report. Nothing runs on its own and nothing is rolled back.

More splits:

- Local modules are judged per export. A helper module that also exports a function reading
  `navigator` or `window` no longer makes its other exports client-only. The module still has to
  evaluate on the server:
  - Next.js rejects a named import of a client-only React API (`useState`) anywhere in the server
    graph (verified with a Turbopack build), so such a module stays client-only;
  - code that runs on import counts, including local functions and callbacks that module-level
    code calls, class `extends` clauses and static fields, and statements that attach functions to
    exports;
  - type imports never count.
- `memo()` and `forwardRef()` are unwrapped, since every importer of a split file is a Server Component:
  - forms covered: `const X = memo(...)`, `export default memo(X)`, `export const X = memo(Inner)` (and a plain `const X = Inner`) for a component declared in the file, `React.memo`, `memo(forwardRef(...))` and an inline comparison function;
  - a `forwardRef` function's unused `ref` is dropped, and `forwardRef<T, P>`'s props type moves onto the parameter;
  - a used `ref` and wrappers that can't be unwrapped still skip as `hoc`, with the reason.
- Effects that no element uses (a `useEffect` setting `document.title`) move to an island that renders nothing, added as the last child of the returned element, where its effects run after everything the component renders, as before. Components with several returns, a component element as their root, a root that can't hold a child, or an island effect declared after the one that would move (their order would swap) still skip, and the message says why.
- A `let` in a component body is supported when it's assigned only in the statements right after it
  (`x = ...`, `x += ...`, or in `if`/`else if`/`else` branches): `let label = "Off"; if (on) label = "On";`
  moves into the island with the state it reads, or stays on the server. A `let` assigned later or in
  a callback, and a hook called while computing one, still skip.
- `outputExists: "alternate"` puts the island into `X.island.client.tsx` (then `island2`, `island3`) when `X.client.tsx` already exists.
- An anonymous default-exported component (`export default function (props) {...}` or `export default (props) => ...`) is split, and named after its file in island names (`BadgeSpan`, not `ComponentSpan`).
- `rules` in the config classifies single exports and calls, not only whole packages:
  - `clientOnlyImports` and `serverSafeExports` take `"pkg#export"` entries;
  - `browserDependentCalls` keeps calls in islands like `Date.now()`;
  - `warnings` adds a warning with your message (new warning code `rule`) when a named call moves to the server.

Workflow:

- `--watch` re-analyses on every source change and prints only the results that changed. Bundles are now cached for the whole process, so only changed files are rebundled.
- Monorepos:
  - `--workspace` runs on every Next.js App Router app of a pnpm, npm, Yarn or Bun workspace and reports them together, relative to the workspace root;
  - `--project <dir>` (repeatable) and `projects` in the root config name the apps;
  - workspace packages linked into `node_modules` are analysed from their source, so a server-safe component from `packages/ui` can stay on the server.

Other:

- Size estimates count a package with a `"use client"` entry as still shipped when a Server
  Component renders it, including the server part of a split file (`<Toaster />` from a toast
  library). Such packages used to be counted as saved.
- `ConfigError` and the new `SnapshotError` are exported.
- `split()` and `explain()` reject what they can't use with a `ConfigError`, instead of guessing: an
  unknown option, a wrong type (`paths: "app"`), a path outside the root, or a missing root, config
  file or file to explain.
- `src/report.ts` moved to `src/report/`.
- The README is shorter, with diagrams of what the tool does and how to use it. The full reference
  moved to docs/cli.md, docs/ci.md and docs/how-it-works.md.
- e2e: the blog app has an `/extra` route covering an effects island, `memo`, `forwardRef` and a per-export-safe helper. All render the same HTML and DOM after the split.
- docs/prior-art.md: RSC X-Ray, client-creep, RSC Boundary, the ServiceUp ESLint plugin and next-component-analyzer, and the status of React Router's and TanStack Start's RSC support. The shiftyp entry is corrected: it's an early prototype.

## 1.0.2 — chained splits, unused directives, timezone warnings, CI reports

- Chained splits in one run. A component that only a client component imports is skipped as
  `imported-by-client`, but becomes splittable once that importer is split. The run now analyses
  such files again, against the earlier changes in memory, until nothing new changes (at most 10
  passes), so a single dry run shows the whole result instead of asking you to rerun. Each file is
  reported once. Size estimates and `minBytesSaved` apply to every pass's changes together, so a
  parent and the child it renders that share a dependency pass the threshold together instead of
  each looking like it saves nothing. A change found in a later pass lists the changes it needs in
  `requires` (the CLI prints "needs …"); if one of them is dropped, so is the change, and its
  `imported-by-client` message names what it needs. `--interactive` still makes one pass. API:
  `split({ iterate: false })` makes one pass.
- New option `removeUnusedDirectives` (CLI: `--remove-unused-directives`), off by default. A
  `"use client"` file with no client-only code (`no-islands`) loses its directive, after the same
  importer checks and self-check as a split. The result has the new status `"directive-removed"`;
  `minBytesSaved` and `minStaticRatio` don't apply, since no file is created, but the saving is
  estimated and reported. The summary lists `directives removed`, and `--check` counts them. With
  the option in the config file, the ESLint rule reports these files too, and fixes them by
  removing the directive (its first autofix). A removal with a warning is an editor suggestion
  instead, so `eslint --fix` and fix-on-save don't apply it unseen; the rule's messages name the
  first warning. Removing a directive can make the files it imports
  splittable, which the next pass picks up.
- Components held in variables no longer block a split. An island element like
  `<LinkIcon className="w-6" />` (with `const LinkIcon = link.icon`) is rendered on the server and
  passed in as `children`, and an object that holds functions crosses the boundary when the island
  reads only its serializable fields (`link={{ name: link.name, href: link.href }}`). This splits
  next-learn's `nav-links.tsx`, which was skipped as `non-serializable-prop`.
- A list item's `key` on a line of its own no longer leaves a blank line in the island.
- `output-exists` and `would-create-route` are checked after the analysis, so a file with another
  problem reports that problem.
- `auto-server-split-ignore` comments: a file whose header has one (before the first import, or
  on the directive's line) is left as it is by the CLI, the API, the size estimates and the ESLint
  rule, and reported as the new skip `ignored` with the reason written after the comment. A comment
  elsewhere in the file doesn't apply, and a change to that file carries an `ignore-outside-header`
  warning that says so.
- Timezone warnings. A change can now carry `warnings` (new `WARNING_CODES` export): date-fns
  formatting and calendar functions (including `formatISO`), dayjs/moment `.format()` without
  `.tz()`/`.utc()`, and `Date`'s local getters (also on optional values) that move from the browser
  to the server are reported as `timezone-dependent`, with their location, in the CLI output, the
  JSON and the reports below. Calls to functions imported from other project files are followed,
  so a `formatDate()` helper that calls date-fns is reported at its call. The change itself isn't
  refused.
- Date-library calls that read the current time stay in islands, like `Date.now()`: date-fns
  `formatDistanceToNow()`, `isToday()`, `isPast()` and the other `isThis…()` checks, `dayjs()` and
  `moment()` without a date, and `.fromNow()`/`.toNow()`/`.calendar()`. 1.0.1 and earlier moved them to the
  server, where a static page computed them once, at build time.
- `--since <ref>` checks only the files changed since a git ref (plus uncommitted and untracked
  ones, with non-ASCII names too); API: `only`. `--write-baseline <file>` records the files that
  have a change available,
  and `--baseline <file>` leaves them as they are (not analysed, not assumed split by estimates);
  API: `baseline`. Together they let `--check` run on an existing app and fail only on new
  opportunities.
- `--format markdown` prints one report (changes, warnings, skips by reason) for a pull request
  comment. `--format github` adds annotations to the text output (a notice per available change,
  a warning per timezone warning, mapped to repository paths through `GITHUB_WORKSPACE`) and appends
  the markdown report to `$GITHUB_STEP_SUMMARY`. Their "apply" commands work when pasted: paths are
  quoted where needed, and they include the changes a file needs and `--remove-unused-directives`
  when it removes a directive. `--json` is `--format json`; combining it with another `--format` is
  an error.
- A GitHub Action (`action.yml`) runs `--check --format github` with the project's installed copy
  (or a given `version`), with inputs for `since`, `baseline`, `working-directory`, extra `args` and
  `fail-on-changes`. It needs 1.0.2 or later, and stops with an error naming the version it found
  otherwise.
- docs/benchmarks.md regenerated: next-learn's `nav-links.tsx` now splits with the thresholds off
  (it was `non-serializable-prop`), and skip messages say what made each element client-only. The
  benchmark script replaces its work directory with `<work dir>` in build errors.
- docs/prior-art.md: the Next.js 16.4 `next-bundle-optimizer` agent skill and bundle analyzer
  export, an unused-directive lint rule, and editor boundary visualizers.

## 1.0.1 — fixes from an integration run

- Size estimates are made for the whole set of splits. A file's estimate assumes the other splits
  the tool proposes for the project are applied too (this run's and those of the other
  `"use client"` files in `include`), so it no longer depends on which paths a run covers. Code
  that several splits remove together is divided between them instead of counting as still
  shipped, so two components that share a dependency no longer block each other at the default
  `minBytesSaved`, and the summary's total matches what the app saves (5.7 KB estimated, 5.6 KB
  measured on the integration app, where 1.0.0 said 190 B). `bytesSaved.sharedWith` lists the
  splits an estimate depends on, and the CLI names them. Splits below `minBytesSaved` are dropped
  until the rest still pass without them.
- A package's own dependencies count as shipping while another client module imports that package
  (1.0.0 counted them as saved).
- Importers outside the TypeScript project (files the tsconfig excludes, `.js` without `allowJs`)
  are checked syntactically instead of blocking the split. Rendering the component as `<X />` is
  fine; an importer whose usage can't be verified (`.mdx`, `require()`, a value use) skips as
  `unsupported-pattern`. `imported-by-client` now only means a client module imports the file.
- Prettier only formats the output when the original file is already formatted with the project's
  config, so lines the split doesn't touch keep every byte. Line endings follow the original with or
  without Prettier (a CRLF file used to become LF under Prettier's default `endOfLine: "lf"`).
- Islands receive only the fields they read from a plain object prop:
  `<KeyedListLi r={{ id: r.id, title: r.title }}>` instead of the whole row.
- Locale-dependent formatting (`toLocaleString()`, `toLocaleDateString()`, `Intl.*`,
  `localeCompare()`…) stays in islands unless the call names its locale (and, for dates, a
  `timeZone`).
- Generated island files (`X.client.tsx`) aren't scanned, so a second run no longer lists them as
  skips. The ESLint rule doesn't report them either.
- The API's `config` option is validated like a config file: unknown keys and invalid values reject
  with a `ConfigError`.
- `--interactive` counts only the accepted splits as split, and lists the rest as `files declined`.
- README: a helper component moved whole into the island file keeps its own name.
- Size measurement no longer follows imports of `"use server"` modules. In the client bundle
  they're server-reference stubs, but esbuild bundled the server code behind them (for example a
  Postgres driver) and failed with `Could not resolve "net"`, so every component that imports a
  Server Action was skipped as `measure-failed` under the default `minBytesSaved`.
- New option `serverSafePackages`: React packages to treat as server-safe (it also overrides the
  built-in client-only list). `lucide-react` and `@tabler/icons-react` join the built-in
  server-safe list. A `"use client"` entry point of a server-safe package (`lucide-react/dynamic`)
  is still a client reference.
- Constants an island uses are copied into the island file instead of being passed as props:
  module-level constants, and body constants that don't depend on props (`const perPage = 6`).
  As props they showed up as `INITIAL_FORM={INITIAL_FORM}` and as new
  `react-hooks/exhaustive-deps` warnings inside the island.
- `state-spans-component` messages say what made each element client-only (for example
  `<div>, <h2>: cn from @/lib/utils is client-only (src/lib/utils.ts:112 uses Math.random())`)
  instead of only listing the elements, and say "client-only code" rather than "client state".
- Client-only code that no rendered element uses gets the same message whether or not the
  component has other islands.
- Island names no longer get a number because a type in the file has the same name
  (`interface ContactForm` no longer turns the island into `ContactForm2`).

## 1.0.0 — interactive mode, docs, benchmarks

- `--interactive`: `[y]es / [n]o / [r]ename islands / [d]iff / [q]uit`; renames re-run the engine
  and its self-check.
- `--version` prints the package version.
- `--write` refuses untracked and git-ignored targets as well as modified ones.
- Effects that sync island state move with that island; shared-context hooks (`usePathname`…) are
  allowed in per-item list islands; `const X = () => <jsx/>` components are no longer mistaken for
  module constants in multi-component files; blank lines between moved statements are kept.
- Real-path resolution of the project root (symlinked checkouts, macOS temp dirs).
- README, `docs/api.md`, `docs/configuration.md`, `docs/eslint.md`, `docs/benchmarks.md`.
- `scripts/benchmark.mjs` (three real App Router apps) and `scripts/perf.mjs` (500-file dry run in
  ~7 s).
- CLI and interactive-mode tests; fixture 32 (`islandsDir`).
- Release prep: `prepublishOnly` runs lint, typecheck and tests (which rebuild `dist/`); Next.js
  hook names moved into the framework adapter so `analysis/` stays framework-neutral; packaging
  verified by installing the packed tarball into a fresh Next.js 16 app (CLI, API, types, ESLint
  plugin, `.ts` config) and running the CLI on Node 20.
- `--interactive` can't be combined with `--dry-run` (it used to write the accepted splits anyway).
- New skip code `measure-failed`: when esbuild can't bundle a file, its saving is unknown, so it no
  longer passes `minBytesSaved` silently. With `minBytesSaved: 0` the file is split and the result
  has `measureError` ("saving not measured" in the CLI output and summary).
- Size measurement no longer fails on CSS Modules (`import styles from "./Card.module.css"`):
  esbuild's built-in `local-css` loader for `.module.css` took precedence over the empty `.css`
  loader, so every such file was skipped as `measure-failed` under the default `minBytesSaved`.
  `.module.css`, `.module.scss`, `.module.sass` and `.module.less` imports are now measured as empty.
- The ESLint rule now applies the CLI's config and thresholds: it loads every config format
  (`.ts`, `.mts`, `.mjs`, `.js`, `.json`), its `minStaticRatio` can raise the config's but not
  lower it, and it measures the saving and applies `minBytesSaved` (new option `measure`). It only
  reports files the CLI would split.
- Untyped linting builds the program the way TypeScript does: a file the tsconfig's `include`
  doesn't match but that an included file imports (for example a `.jsx` component with `allowJs`)
  is analysed, as the CLI already did.
- Files saved with Windows line endings (CRLF) keep them: inserted lines and the island file use
  the original's line ending. They used to come out LF, and an interactive rename turned the whole
  rewritten file LF (ts-morph's `replaceWithText` rewrites line breaks; the self-check now sets
  file text byte for byte).
- Repository housekeeping: author and license holder set to Himesh Gunathilake; fixtures moved to
  `test/fixtures/`; `CONTRIBUTING.md`, `.editorconfig`, `.nvmrc`; `format`/`format:check` scripts
  (checked in CI); `noUnusedLocals`/`noUnusedParameters`; unused exports and dead helpers removed.

## 0.5.0 — ESLint plugin

- `auto-server-split/eslint`: flat-config plugin with `prefer-server-split` (report only, on the
  `"use client"` directive) and `configs.recommended` (`warn`, `minStaticRatio: 0.5`).
- Typed linting uses the full project for the program's tsconfig; without it, a lazy project loads
  only the linted file, its imports and its importers (module graph built syntactically). Both are
  cached per tsconfig for the lint process. The rule runs the self-check before reporting.
- Engine refactor: synchronous `analyzeFile` / `checkAnalyzed`, `createRunContext`.
- RuleTester tests with and without typed linting.

## 0.4.0 — multiple components, Mongoose, JSX

- Multiple components per file: unchanged server components, wholesale-moved interactive helpers,
  server components copied into islands that render them.
- `mongoose.autoSerialize`: Mongoose documents and ObjectId-bearing values crossing the boundary
  are reduced to the fields the island reads (`String()` for ObjectIds, Dates kept).
- `.jsx` input (untyped-boundary rules), CSS Modules on both sides, `src/` path aliases.
- Second e2e app (`shop`); both apps pass the before/after DOM equality checks.
- Fixtures 28–31c.

## 0.3.0 — donut slots, e2e

- Donut/slot pattern: static, non-trivial subtrees inside an island stay on the server and are
  passed in as `children` (or `slot1`, `slot2`, ...).
- `e2e/run.mjs` + `e2e/apps/blog`: `next build` before and after `--write`, identical server HTML,
  identical DOM after hydration and after every Playwright interaction, per-route JS sizes.
  Blog app: 16 components split, 5 skipped as expected, `/` ships 18.5 KB gzip less JavaScript.
- Fixture 27 (accordion donut), donut unit tests.

## 0.2.0 — grouping, loops, packages, size

- Union-find grouping of anchors that share client state or handlers; LCA island roots; merging of
  nested islands; escape check.
- `.map` loop islands (loop variable becomes a prop, `key` moves to the usage). Islands that need
  component-level hooks are hoisted above the `.map` so state stays shared.
- Custom hooks (imported or declared in the file), browser globals, client-only packages
  (framer-motion etc.), `next/navigation` hooks.
- Server Actions: imported actions move with the island; action props pass through when every
  importer passes a Server Action.
- Module-level helpers and constants used by islands are copied into the island file and removed
  from the server file when no longer used there.
- Unit tests: LCA, grouping/union-find, taint propagation, loop rule, import pruning.
- Fixtures 08–26.

## 0.1.0 — first split

- Module graph over the whole tsconfig program plus JS/MDX files outside it (static imports,
  re-exports, `import()`, `require`), with client reachability from `"use client"` roots.
- Importer check (direct, through barrels, dynamic, value usage).
- Client-only marking: hooks, event/ref/function props, browser globals, client-only packages,
  render nondeterminism, with fixpoint propagation over the component body.
- Leaf islands (plus union-find grouping, LCA, escape check and `.map` handling, unit-tested in 0.2).
- Free variables become props; serializability checked with the type checker.
- Rewrite with magic-string (untouched bytes preserved), island file generation, import
  move/copy/prune, optional Prettier pass.
- Self-check before every report/write: parse, no new type errors, no client code left, serializable
  props, no server-only imports in the island.
- esbuild size measurement (isolated + conservative gzip), `minBytesSaved`, `minStaticRatio`.
- CLI: `--dry-run` (default), `--write` (git-dirty guard, `--allow-dirty`), `--check` (exit 2), `--json`,
  `--config`, `--root`, `--verbose`, `--no-measure`.
- Config file loading and validation (`auto-split.config.{ts,mts,mjs,js,json}`).
- Fixtures: PostCard (exact spec output), server props, two islands, and skips for client importer,
  context provider, function prop, conditional hook.

## 0.0.0 — scaffold

- pnpm + tsup (ESM only) + strict TypeScript + Vitest + ESLint flat config + GitHub Actions CI.
- Fixture runner (`test/fixtures.test.ts`) with `UPDATE_FIXTURES=1` regeneration.
- `SkipCode` framework (`src/analysis/skip.ts`).
- `docs/prior-art.md`: no existing tool performs this split automatically.
- npm name `auto-server-split` checked: available (404 on 2026-10-19).
