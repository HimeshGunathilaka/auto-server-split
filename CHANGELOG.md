# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

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
