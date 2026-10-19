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

## 0.1 — first split

### Unknown means client

Moving code *into* an island preserves behaviour (it was client code before). Only moving code
*to the server* is risky. So everything the analysis can't prove server-safe is treated as
client-only and ends up inside an island:

- packages that depend on React, have no `"use client"` entry, and aren't on the built-in
  server-safe list (`@heroicons/react`, `@radix-ui/react-icons`);
- unresolvable imports;
- project modules that aren't client-free all the way down. A module counts as client-free if
  neither it nor anything it imports (stopping at `"use client"` modules, which become client
  references) uses hooks, event/ref props, browser globals, client-only packages, class components,
  `createContext`, or server/browser-different env values. This is decided **per module**, not
  per export, so a single client-only helper makes the whole module client-only. That costs savings,
  never correctness. Per-export analysis is a possible later refinement.

Components imported from `"use client"` modules (including `next/link`, `next/image`) stay in the
server file as client references when every prop is serializable; otherwise they become islands.

### Extra client-only markers

Besides the spec's list:
- **Render nondeterminism:** `Date.now()`, `new Date()` with no arguments, `Math.random()`,
  `performance.now()`, `crypto.randomUUID()`/`getRandomValues()`. A client component re-renders
  these in the browser after hydration; a Server Component wouldn't, so the visible output could
  change. They stay in islands.
- More browser globals (`self`, `screen`, `innerWidth`, `getComputedStyle`, `setTimeout`, `Image`, ...).
  See `BROWSER_GLOBALS` in `src/analysis/taint.ts`.

`format(new Date(post.date), "PPP")` from the spec's fixture still stays on the server, as the spec
requires. Timezone/locale differences between server and browser are listed under limitations.

### Free variables that can't be props are copied, not refused

A component-local declaration that an island needs but that isn't serializable (a helper
function, a class instance) is **copied** into the island instead of failing the split. It's
removed from the server component when nothing there reads it any more. Module-level helper
functions and non-serializable module constants are copied into the island file the same way.
Serializable module constants become props, as the spec says. The copied code ran in the browser
before, so this keeps the original behaviour. Component props (parameters) and `.map` callback
variables are never copied; if they aren't serializable the file is skipped.

### Stricter candidate rules

- The component body may only contain `const` declarations, function declarations, hook-call
  statements, simple early returns (`if (cond) return …;`) and the final `return`. Anything else
  (`let`, loops, `try`, side-effect statements) is `unsupported-pattern`.
- Module-level `let`/`var` (it would become state shared between requests on the server),
  module-level side-effect statements, and side-effect imports of JS modules
  (`import "./polyfill"`) are `unsupported-pattern`. Stylesheet side-effect imports stay with the
  server component.
- Hooks inside the returned JSX are `conditional-hooks-or-returns`.
- Client-only code that no rendered element depends on (a standalone `useEffect`) is
  `unsupported-pattern`: there is no island to carry it without changing when it runs.
- Importers must use the component only as `<X />` (or in types). Passing the component as a value
  is `unsupported-pattern`, because a Server Component function can't be passed to client code.
  Importers outside the TypeScript program (e.g. `.mdx`, or `.js` without `allowJs`) count as
  unverifiable (`imported-by-client`); `import()` importers give `dynamic-import`.
- Next.js `error.tsx` / `global-error.tsx` must stay Client Components, so they're skipped.
- Any `pages/` directory is treated as route territory for `would-create-route`.

### Import handling on the server side

Imports that the server part no longer references are removed. If an import from a non-neutral
module (client-only package, `"use client"` module) is still referenced but only in type positions,
it's rewritten as `import type`. That way the client module isn't evaluated on the server even
without `verbatimModuleSyntax`.

### Generated code shape

- Island functions destructure props under their original names (`{ post, count }`), so moved code
  is byte-identical to the original apart from indentation.
- Props are ordered by declaration (component parameters first, in order), then by name.
- For a list island the `key` attribute moves from the island's root to the `<Island key={…} />`
  usage.
- Quote style, semicolons and the indentation unit are copied from the original file.
- Prettier runs only when `prettier: "auto"`, the project has Prettier installed, and a Prettier
  config is found **inside the project root** (a config in a parent directory is ignored).

### Self-check compares diagnostics by message, not position

Positions move during a split, so "no new diagnostics" is checked as a multiset of
`(code, message)` over the original file plus the island file, and separately per importer file.
The check mutates the shared ts-morph project in memory and always restores it (`finally`).

### Size measurement landed early (spec 5.8)

`minBytesSaved` defaults to 2048, so the measurement had to exist for any default-config split to
be meaningful. It ships in 0.1 rather than 0.2. If esbuild can't bundle a file on its own,
`bytesSaved` is omitted and `minBytesSaved` isn't applied, because the saving is unknown, not zero.

### CLI

- `--write` refuses outside a git repository (it can't verify there are no uncommitted changes)
  unless `--allow-dirty` is passed.
- Any `internal-error` makes the exit code `1`.
- `--interactive` is accepted but reports "not available yet" until 1.0.
