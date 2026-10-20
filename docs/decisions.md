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
before v0.4 (superseded: supported since 0.4), or statements in the component body other than
declarations, hook calls and early returns).
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
- `--interactive` is accepted but reports "not available yet" until 1.0 (superseded: implemented in 1.0).

## 0.2 — grouping, loops, packages, size

### Loop islands never take component-level hooks

The spec's loop rule makes the mapped element the island root, so the island renders once per
item. If that island needed a hook declared at component level (for example a `useState` shared by
every item), each item would get its own copy of the state, which is a behaviour change. In that
case the root climbs out to the element that contains the `.map`, and the state stays shared.
Per-item islands are used only when the island's client code has no hooks (e.g. handlers that use
browser globals or only the loop variable).

### Copied module-level code resolves at module scope

When a module-level helper is copied into the island file (a local custom hook, a formatter), the
names it uses are copied with it (constants, other helpers, imports). They never become props,
because the helper's code lives at module level in the island file, not inside the island component.

### Server Action props

A component prop with a function type normally can't cross the boundary. It's allowed when *every*
importer's JSX usage passes a Server Action for that prop: an export of a `"use server"` module, or
a function whose body starts with `"use server"`. If any usage spreads props (`{...props}`), no prop
qualifies. The self-check applies the same rule.

### Self-check: event/ref props only on DOM elements

A prop named `onSubmit` on a generated island or another component isn't an event handler; it's
judged by its value (functions are rejected unless they are Server Actions). On DOM elements every
`on*`/`ref` prop is still rejected.

## 0.3 — donut slots and e2e

### Donut slot selection

A slot is a JSX subtree inside an island that is (a) reached from the island root only through
direct JSX children (so it can't sit under a condition, a `.map`, or an attribute), (b) free of
anchors, client-only reads, hooks and render nondeterminism, and (c) non-trivial: more than one
element, or a call to an imported function (that call is usually the reason to keep it on the
server, e.g. `format()` from date-fns). The largest qualifying subtrees are chosen. One slot is
passed as `children` unless the island already takes a `children` prop; several are `slot1`,
`slot2`, ... (typed `ReactNode`, using the file's own React import when it has one). The slot's
code is evaluated on the server, so its values don't become island props.

### E2E harness details

- The "before" and "after" builds run **one after the other in the same directory**
  (`e2e/.tmp/<app>`). Turbopack derives CSS-module class names from the file path, so two copies
  in different directories would differ for reasons that have nothing to do with the split.
- HTML normalisation removes `<script>`, `<link>`, comments, build hashes/ids and whitespace. Both
  the server HTML (fetched) and the live DOM after hydration and after **every** interaction step
  must match. Every click step must also change the DOM in the split build, which proves the
  island is interactive.
- Per-route client JS is the gzip size of the `<script src>` files referenced by the route's HTML.
  Counting network traffic would include `<Link>` prefetches of other routes.
- Builds and browsers use `TZ=UTC` / `timezoneId: "UTC"` so date formatting is stable.
- Next.js 16 no longer prints per-route sizes in `next build`, which is why sizes are measured
  from the served pages.

## 0.4 — multiple components, Mongoose, JSX

### Multiple components per file

Every component in the file is planned; together they share one island file.
- A component with no client-only code stays as it is (it becomes a Server Component).
- A **non-exported** helper component that is entirely interactive (`fully-interactive` or
  `state-spans-component` on its own) moves **wholesale** into the island file, exported from
  there, and is imported back. Other components render it as a client reference, so its props
  must be serializable (otherwise the usage becomes part of an island). Planning repeats until
  the set of moved components is stable. An *exported* component that is entirely interactive
  still skips the whole file: moving it would change what importers get.
- A server-safe component of the file that an island renders (e.g. a small `Avatar`) is **copied**
  into the island file (its original code, without `export`), and removed from the server file if
  nothing there uses it any more.
- A skip in any component skips the file, with the component's name in the message.

### Mongoose / ObjectId picking builds an object, not flat props

With `mongoose.autoSerialize`, the prop keeps its name and shape, but only the fields the island
reads are passed, as an object literal built on the server:
`post={{ _id: String(post._id), author: { name: post.author.name }, createdAt: post.createdAt }}`.
That way the island's code doesn't change at all; only the prop's type changes, so the self-check
can verify every use. Field paths stop at the first serializable value (or ObjectId). Nullable
ObjectIds become `x == null ? x : String(x)`. The split is refused when the island uses the whole
object (spread, passing it on, `JSON.stringify`), uses `?.` or element access on it, or calls an
ObjectId method other than `toString()` (a string wouldn't have it). This is often useful for
apps whose runtime values are already plain JSON but whose types still say `ObjectId`:
`String(id)` is correct for both.

### `.jsx`

JS files need to be in the TypeScript program (`allowJs`, or a `jsconfig.json`). Island files get
the same extension (`X.client.jsx`) and no type annotations. Only props whose inferred types are
primitive (including literals and defaulted parameters such as `{ initial = 0 }`) may cross the
boundary; anything else is `untyped-boundary`.

### E2E shop app

The second app (`e2e/apps/shop`) uses a `src/` layout with `@/* → ./src/*`, a `.jsx` island, a
multi-component file with a wholesale-moved helper, Mongoose-typed props and an
`auto-split.config.ts` file. Its JS saving is small because its components have no heavy
dependencies. That's expected: the savings come from code that stays on the server, and here that
is mostly markup.

## 0.5 — ESLint plugin

### No autofix (as specified)

An ESLint fix can only edit the file being linted, and a split has to create a new file
(`X.client.tsx`). Faking it (writing files from inside a rule, or a suggestion that leaves the
code broken until another file appears) would violate both ESLint's model and this tool's
"never produce broken code" rule. So the rule only reports, and its message names the CLI command
that applies the split.

### Two modes, both conservative

- **Typed linting** (`parserServices.program` present): the rule loads its own ts-morph project
  from the program's tsconfig (`configFilePath`), so it sees exactly what the CLI sees.
- **No typed linting:** the nearest `tsconfig.json`/`jsconfig.json` is found, the module graph is
  built syntactically from its file list, and a lazy project loads only the linted file, what it
  imports, its importers (through barrels) and ambient `.d.ts` files. If an importer can't be
  loaded, or the file isn't covered by the tsconfig, nothing is reported.
- Both modes are cached per tsconfig for the lifetime of the lint process. The linted file's
  in-editor text replaces the on-disk text before analysis. The module graph isn't rebuilt
  within a process, so a newly added importer is seen on the next lint run.
- The rule runs the self-check before reporting (`selfCheck: false` turns it off for speed), so it
  only suggests splits the CLI would actually perform.
- ESLint rules are synchronous, so the rule reads `auto-split.config.json` but not `.ts`/`.mjs`
  config files. Rule options (`minStaticRatio`) override it.

## 1.0 — interactive mode, docs, benchmarks

### Interactive renames go back through the engine

`[r]ename` doesn't search-and-replace the generated text. It re-runs the file with a
`default name → new name` map, so the rename passes the same validation (a valid component name,
not already used in the file) and the same self-check as any other split. Default names are
assigned first, so renaming one island never changes another island's default name.

### `--write` also refuses untracked and git-ignored targets

"Uncommitted changes" includes files git can't restore: untracked (`??`) and ignored (`!!`) files
are refused too (`git status --porcelain --ignored --untracked-files=all`). `--allow-dirty`
overrides this.

### Paths are resolved to real paths

The project root is resolved with `realpath`, because TypeScript resolves symlinks (for example
macOS `/var` → `/private/var`), and globbed paths must match the program's file names.

### Effects join the island whose state they use

A client statement that no element reads directly (typically a `useEffect` that syncs state) is
attached to the island that owns the client state it depends on. If it depends on several
islands' state, they merge. If it depends on none, the file is still skipped
(`unsupported-pattern`): there's no island to carry it without changing when it runs. An island
that carries an effect is never a per-item list island, so the effect still runs once.

### Shared-context hooks may run per list item

`usePathname`, `useSearchParams`, `useParams`, `useRouter`, `useSelectedLayoutSegment(s)`,
`useContext` and `use(Context)` return the same value for every caller, so a per-item `.map`
island may call them. Any other hook (state, refs, effects, custom hooks) still hoists the island
above the `.map`.

### Benchmarks

`scripts/benchmark.mjs` clones three App Router apps at pinned commits (vercel/next-learn
dashboard, vercel/commerce, timlrx/tailwind-nextjs-starter-blog) outside the repository, installs
them with lifecycle scripts disabled, and records split/skip rates and estimated savings with the
default thresholds and with thresholds off. With `--build`, it builds each app before and after
`--write` and compares the app's own `tsc --noEmit` output. Results: zero self-check failures,
zero internal errors, zero new type errors, and every app that built before still builds after.
The next-learn dashboard needs a Postgres database at build time, so its build can't run here;
the typecheck comparison covers it. These apps are already well-factored, so there are few splits;
see `docs/benchmarks.md`.
