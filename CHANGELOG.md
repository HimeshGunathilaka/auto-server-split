# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org/).

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
