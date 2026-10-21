# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

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
