# Contributing

## Setup

Node.js 22 or later for development (the published package supports Node.js 20+), and pnpm.

```bash
pnpm install
npx playwright install chromium   # only needed for the e2e tests
```

## Commands

| Command                              | What it does                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                         | Bundles `src/` into `dist/` with tsup.                                                                                                                                       |
| `pnpm typecheck`                     | `tsc --noEmit` over `src/` and `test/`.                                                                                                                                      |
| `pnpm lint`                          | ESLint.                                                                                                                                                                      |
| `pnpm format` / `pnpm format:check`  | Prettier.                                                                                                                                                                    |
| `pnpm test`                          | Builds, then runs the unit, fixture, CLI and ESLint-rule tests (Vitest).                                                                                                     |
| `pnpm test:e2e`                      | For each app in `e2e/apps/`: `next build` before and after `--write`, identical HTML and DOM after every Playwright interaction, per-route JS sizes. Run `pnpm build` first. |
| `node scripts/perf.mjs 500`          | Times a dry run on a generated 500-file app.                                                                                                                                 |
| `node scripts/benchmark.mjs --build` | Runs on three real open-source apps and rewrites `docs/benchmarks.md`.                                                                                                       |

## Layout

```
src/
  index.ts             public API: split(), defineConfig(), types
  cli.ts               the auto-server-split command
  interactive.ts       --interactive review
  split.ts             per-run orchestration (project, graph, per-file pipeline)
  types.ts             public types
  config/              config file loading and validation
  project/             ts-morph project, module graph, package classification (all I/O)
  analysis/            pure analysis: directives, components, taint, islands, serializability, skips
  frameworks/next.ts   everything Next.js-specific
  transform/           rewrite and island emission (magic-string), Prettier
  verify/              the self-check that runs before anything is reported or written
  measure/             esbuild bundle-size estimate
  eslint/              ESLint plugin and the prefer-server-split rule
test/
  fixtures/NN-name/    input/ plus output/ (exact expected files) or expected-skip.json
  eslint-project/      a small project used by the ESLint rule tests
  unit/                unit tests
  *.test.ts            fixture runner, CLI, interactive mode, ESLint rule
e2e/                   e2e harness and the Next.js apps it builds
scripts/               perf and benchmark scripts
docs/                  user docs, design decisions, benchmarks
```

`src/analysis/` does no I/O: it receives a parsed project and a module graph and returns data.
Expected skips are returned as values (`Outcome<T>`), never thrown.

## Fixtures

Each case in `test/fixtures/NN-name/` has an `input/` project and either `output/` (exactly the
files the split touches or creates) or `expected-skip.json` (`{ "file", "code", "messageIncludes"? }`).
An optional `fixture.json` sets `config` overrides or `measure`.

`UPDATE_FIXTURES=1 pnpm test` regenerates every `output/`. Review those diffs by hand before
committing. The README's PostCard example is also pinned in `test/readme-example.test.ts`, so it can't
change silently.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`.
2. `pnpm test:e2e` (CI runs it too).
3. `npm publish` (`prepublishOnly` runs lint, typecheck and the tests, which rebuild `dist/`).
