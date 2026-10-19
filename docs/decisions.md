# Decisions

Places where the implementation departs from, or fills a gap in, the build spec. Newest milestone last.

## 0.0 — scaffold

### Toolchain versions (looked up 2026-10-19)

| Package | Version | Note |
|---|---|---|
| next | 16.4.2 | used by e2e apps and fixture types |
| react / react-dom | 19.3.1 | |
| typescript | **6.0.3** (dev) | See below. `latest` on npm is 7.0.2 |
| ts-morph | 28.0.0 | bundles TypeScript 6.0.2 |
| esbuild | 0.28.2 | |
| eslint | 10.13.0 | |
| typescript-eslint | 8.71.2 | supports `typescript >=4.8.4 <6.1.0` |
| prettier | 3.9.10 | optional peer |
| vitest | 5.0.5 | |
| tsup | 9.0.0 | |

### TypeScript 6, not 7

TypeScript 7 (the Go-native compiler) is the current `latest`, but its JavaScript API is only exposed
under `typescript/unstable/*`, and neither ts-morph (bundles TS 6.0.2) nor typescript-eslint (`<6.1.0`)
supports it. The analysis engine uses the TypeScript that ts-morph bundles, so it does not need the
user's `typescript` at all. TS 6 and TS 7 accept the same language, so analysing a TS 7 project with the
TS 6 checker is sound. `typescript` stays an *optional* peer dependency (`>=5.4`): it's only used when
the ESLint rule runs with typed linting.

### Node versions: runtime >= 20, toolchain >= 22

The package declares `engines.node >= 20` and is built with `target: node20`. Vitest 5 and tsup 9
themselves require Node >= 22 (and Node 20 reached end-of-life in April 2026), so the spec's "CI on
Node 20 and 22" is implemented as:
- full lint/typecheck/test/build on Node 22 and 24;
- a Node 20 job that builds on 22, then runs the built CLI on Node 20 (`e2e/smoke.mjs`).

### Expected skips are values, not exceptions

Analysis steps return `Outcome<T>` (`{ ok: true, value } | { ok: false, skip }`) from
`src/analysis/skip.ts`. Exceptions are reserved for real bugs and are reported per file as
`internal-error`.

### Extra skip code: `unsupported-pattern`

The spec's table has no code for "valid code this version doesn't handle yet" (for example a
standalone `useEffect` that no interactive element depends on, more than one component in a file
before v0.4, or statements in the component body other than declarations, hook calls and early returns).
Rather than overload an unrelated code, these use `unsupported-pattern` with a specific message.
