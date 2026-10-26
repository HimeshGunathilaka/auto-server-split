# Decisions

Design decisions and the reasoning behind them, grouped by the release that introduced them.
Oldest first.

## 0.0 — scaffold

### Toolchain versions (looked up 2026-10-19)

| Package           | Version         | Note                                 |
| ----------------- | --------------- | ------------------------------------ |
| next              | 16.4.2          | used by e2e apps and fixture types   |
| react / react-dom | 19.3.1          |                                      |
| typescript        | **6.0.3** (dev) | See below. `latest` on npm is 7.0.2  |
| ts-morph          | 28.0.0          | bundles TypeScript 6.0.2             |
| esbuild           | 0.28.2          |                                      |
| eslint            | 10.13.0         |                                      |
| typescript-eslint | 8.71.2          | supports `typescript >=4.8.4 <6.1.0` |
| prettier          | 3.9.10          | optional peer                        |
| vitest            | 5.0.5           |                                      |
| tsup              | 9.0.0           |                                      |

### TypeScript 6, not 7

TypeScript 7 (the Go-native compiler) is the current `latest`, but its JavaScript API is only exposed
under `typescript/unstable/*`, and neither ts-morph (bundles TS 6.0.2) nor typescript-eslint (`<6.1.0`)
supports it. The analysis engine uses the TypeScript that ts-morph bundles, so it does not need the
user's `typescript` at all. TS 6 and TS 7 accept the same language, so analysing a TS 7 project with the
TS 6 checker is sound. `typescript` stays an _optional_ peer dependency (`>=5.4`): it's only used when
the ESLint rule runs with typed linting.

### Node versions: runtime >= 20, toolchain >= 22

The package declares `engines.node >= 20` and is built with `target: node20`. Vitest 5 and tsup 9
themselves require Node >= 22 (and Node 20 reached end-of-life in April 2026), so CI is
set up as:

- full lint/typecheck/test/build on Node 22 and 24;
- a Node 20 job that builds on 22, then runs the built CLI on Node 20 (`e2e/smoke.mjs`).

### Expected skips are values, not exceptions

Analysis steps return `Outcome<T>` (`{ ok: true, value } | { ok: false, skip }`) from
`src/analysis/skip.ts`. Exceptions are reserved for real bugs and are reported per file as
`internal-error`.

### Extra skip code: `unsupported-pattern`

The other skip codes don't cover "valid code this version doesn't handle yet" (for example a
standalone `useEffect` that no interactive element depends on, more than one component in a file
before v0.4 (superseded: supported since 0.4), or statements in the component body other than
declarations, hook calls and early returns).
Rather than overload an unrelated code, these use `unsupported-pattern` with a specific message.

## 0.1 — first split

### Unknown means client

Moving code _into_ an island preserves behaviour (it was client code before). Only moving code
_to the server_ is risky. So everything the analysis can't prove server-safe is treated as
client-only and ends up inside an island:

- packages that depend on React, have no `"use client"` entry, and aren't on the built-in
  server-safe list (icon libraries such as `@heroicons/react` and `lucide-react`) or the
  `serverSafePackages` config;
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

Besides hooks, event props, the common browser globals and client-only packages:

- **Render nondeterminism:** `Date.now()`, `new Date()` with no arguments, `Math.random()`,
  `performance.now()`, `crypto.randomUUID()`/`getRandomValues()`. A client component re-renders
  these in the browser after hydration; a Server Component wouldn't, so the visible output could
  change. They stay in islands.
- More browser globals (`self`, `screen`, `innerWidth`, `getComputedStyle`, `setTimeout`, `Image`, ...).
  See `BROWSER_GLOBALS` in `src/analysis/taint.ts`.

`format(new Date(post.date), "PPP")` in the README example still stays on the server. Timezone/locale differences between server and browser are listed under limitations.

### Free variables that can't be props are copied, not refused

A component-local declaration that an island needs but that isn't serializable (a helper
function, a class instance) is **copied** into the island instead of failing the split. It's
removed from the server component when nothing there reads it any more. Module-level
declarations (helpers and constants, serializable or not) are copied into the island file the same
way, and so are body constants that don't depend on props or render-time values (`const perPage =
6`). The copied code ran in the browser before, so this keeps the original behaviour. It also
keeps hook dependency lists valid: a constant turned into a prop would become a dependency the
`react-hooks/exhaustive-deps` lint rule asks for. Values computed from props stay on the server
and cross as props. Component props (parameters) and `.map` callback variables are never copied;
if they aren't serializable the file is skipped.

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
  unverifiable (`imported-by-client`); `import()` importers give `dynamic-import`. (Superseded in
  1.0.1: they're checked syntactically, and an unverifiable one is `unsupported-pattern`.)
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
  config is found **inside the project root** (a config in a parent directory is ignored). (1.0.1:
  and only when the original file is already formatted with that config.)

### Self-check compares diagnostics by message, not position

Positions move during a split, so "no new diagnostics" is checked as a multiset of
`(code, message)` over the original file plus the island file, and separately per importer file.
The check mutates the shared ts-morph project in memory and always restores it (`finally`).

### Size measurement landed early

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

The basic loop rule makes the mapped element the island root, so the island renders once per
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

A component prop with a function type normally can't cross the boundary. It's allowed when _every_
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
  the set of moved components is stable. An _exported_ component that is entirely interactive
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

### No autofix

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
  config files. Rule options (`minStaticRatio`) override it. (Superseded in 1.0: the rule loads
  every config format synchronously, and its `minStaticRatio` can only raise the config's.)

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

### `--interactive` is never a dry run

`--interactive` writes the splits you accept, so combining it with `--dry-run` is an error, like
`--json` and `--check`, rather than silently writing. `--dry-run` alone already shows every diff.

### A saving that can't be measured doesn't pass `minBytesSaved`

The measurement bundles the original file and the island with esbuild. When esbuild can't (an
import only the project's own bundler understands, a file type without a loader), the saving is
unknown. With `minBytesSaved` above 0 the file is skipped as `measure-failed`, with esbuild's error
in the message: applying a threshold-gated split without knowing the saving would make the
threshold meaningless. With `minBytesSaved: 0` there's nothing to check, so the file is split and
the result carries `measureError` ("saving not measured" in the CLI). `--no-measure` remains the
explicit opt-out. The measurer uses esbuild's synchronous API (no slower in practice) so the CLI
and the ESLint rule share it.

### Server Action modules are external when measuring

A client file that imports a `"use server"` module gets a small server-reference stub in its
bundle, not the module's code. The measurement marks those modules external (by resolved path, so
aliases are covered) instead of following them into database drivers and Node built-ins, which
esbuild can't bundle for the browser and which made every such file `measure-failed`.

### Line endings follow the original file

The analysis reads CRLF and LF files the same way (every fixture gives the same result on a CRLF
copy), but the emitter writes `\n`. After emitting, the island file is converted to the original's
line ending, taken from its first line break (the rule Prettier's `endOfLine: "auto"` uses), and so
is the rewritten file when the original uses one ending throughout, which changes only the lines
the tool inserted. A file that already mixes CRLF and LF is left as it is rather than normalised,
since rewriting lines the split didn't touch would break the "untouched bytes stay" rule. This is
safe for code: template literals and line continuations read CRLF and LF the same way, and JSX
text treats both as a line break. When the project's Prettier formats the output, its `endOfLine`
decides, as it would for `prettier --write`. (Superseded in 1.0.1: Prettier is given the original's
line ending, so the rule holds with Prettier too.)

ts-morph's `replaceWithText` rewrites every line break as LF, so the self-check, which swaps the
generated text in and back out, used to leave an LF copy of a CRLF original in memory; anything that
re-analysed the file later (interactive renames, the ESLint rule's next lint) saw LF.
`setSourceText` replaces the whole text with `applyTextChanges`, which keeps it byte for byte.

`test/line-endings.test.ts` reruns every fixture on CRLF input and requires the expected output
with CRLF line endings, byte for byte.

### The ESLint rule applies the CLI's config and thresholds

The rule's job is to point at splits the CLI will perform, so it can't use a different config or
skip a check the CLI runs:

- it loads `auto-split.config.{ts,mts,mjs,js,json}` synchronously (esbuild bundles the file to
  CommonJS, which is evaluated with the same `defineConfig` shim the CLI uses);
- its `minStaticRatio` option (default 0.5, so lint only flags clear wins) is combined with the
  config's as a maximum: the option can raise the bar, never lower it below the CLI's;
- it measures the saving with the same measurer and applies `minBytesSaved` and `measure-failed`
  (rule option `measure: false` turns this off, like `--no-measure`).

`test/eslint-parity.test.ts` lints projects with each config format, with and without typed
linting, and requires the rule to report exactly the files `split()` splits, with the same island
counts and static ratios.

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

## 1.0.1 — fixes from an integration run

These come from running 1.0.0 on a fixture app (44 `"use client"` components, five routes) and
comparing the built app before and after: server HTML, client JavaScript per route, and the DOM
after clicking every interactive element.

### Size estimates are made for the whole set of splits

The 1.0 estimate looked at one file at a time: code the file removed counted as saved only if no
other client module imported it. Two components that shared a dependency (both used `date-fns`)
each saw the other still shipping it, so each estimated about 0 B; at the default `minBytesSaved`
neither was ever split, and running the tool again couldn't change that. The summary was also far
too low: 190 B estimated where the built app saved 5.6 KB on one route and 18.8 KB on two others.

The estimate now assumes every split the tool proposes for the project is applied:

- The set is the run's own splits plus those of the other `"use client"` files in `include`
  (analysed without the self-check). It doesn't depend on the paths a run covers, so a file gets
  the same estimate in a one-file run, a folder run and the ESLint rule, and splitting folders one
  at a time can't deadlock either.
- "Still shipped" is worked out on the client graph as it would be after those splits: the split
  files stop being client roots and their island files become roots (their imports are parsed from
  the generated text).
- A package's own dependencies keep shipping while that package does. esbuild's metafile says
  which top-level packages pull each `node_modules` file into a bundle; 1.0 counted such a file as
  removed even when another client module still imported the package that pulls it in.
- Code that several splits remove together is divided between them, so the per-file estimates add
  up to the project total instead of counting a shared package once per file. The result lists the
  other splits (`bytesSaved.sharedWith`), and the CLI says the estimate assumes them.
- Splits below `minBytesSaved` are dropped and the rest re-measured until nothing else drops: a
  dropped split's original keeps its dependencies shipping, which can push another split below the
  threshold. The set only shrinks, so this ends after at most one round per split. A dropped file's
  message reports its saving measured against the final set.

It stays conservative where it has to guess: the estimate is project-wide, not per route, so
anything any remaining client module imports counts as shipped everywhere. On the fixture app the
summary now says 5.7 KB, and the route that renders both shared components saves 5.6 KB.

The ESLint rule uses the same set, worked out once per lint process. Its own `minStaticRatio` is now
applied on top of the CLI's config rather than folded into it, so the rule's set of other splits
is exactly the CLI's.

### Importers outside the TypeScript project are checked without types

A `.tsx` file the tsconfig excludes (tests, a backup copy of the source tree) is still part of the
module graph, because it can import a component. 1.0 refused every such importer with the code
`imported-by-client` ("imported by a client module"), although it usually wasn't one. In one run, a
backup copy of the source tree blocked 27 of 35 candidates that way.

Now the importer is parsed and checked syntactically: the bindings it imports from the component
file (or from a barrel that re-exports it, followed by name) may only appear as JSX tags, in types
or in re-exports. Without scope information any other identifier with the same name counts as a
use, which can only make the check stricter. `require()` of the file, and `.mdx` importers, can't be
verified and skip as `unsupported-pattern`. Only a real client importer gives `imported-by-client`.
Such importers aren't added to the self-check's diagnostics comparison, since they have no
diagnostics in the program.

### Prettier only formats files that were already formatted

With a Prettier config present, 1.0 ran Prettier over the whole rewritten file. That broke the
"untouched bytes stay" rule (an untouched 105-character signature was rewrapped onto 9 lines) and,
with Prettier's default `endOfLine: "lf"`, turned a CRLF file into LF.

Prettier now runs only when the original is already formatted with the project's config (checked
with `prettier.check`, line endings aside). Then the only lines that can change are the ones around
the edits. The island file follows the same rule: its code comes from the original, so it keeps
the original's formatting when the original wasn't formatted. `endOfLine` is always set to the
original's line ending, so CRLF files stay CRLF with or without Prettier.

### Islands get only the fields they read

1.0 passed whole objects across the boundary: `<KeyedListLi r={r}>` serialized the row's `md`
field although the island only read `r.id` and `r.title`. The Mongoose field-picking from 0.4 now
applies to any plain object prop: when every reference in the island is a non-optional property
read (`r.title`, not `r?.title`, `r["title"]`, a write or a use of `r` itself) and the island
doesn't read every field anyway, the server passes `r={{ id: r.id, title: r.title }}` and the prop
is typed `{ id: string; title: string }`. The island's code is unchanged. Arrays, `Date`, `Map`,
class instances, index signatures and unions are passed whole.

### Locale-dependent formatting stays in islands

`toLocaleString()` in markup used to move to the server, where the locale and timezone are the
server's rather than the user's. Before the split the component re-rendered in the browser, so the
user saw their own locale. `toLocaleString()`, `toLocaleDateString()`, `toLocaleTimeString()`,
`toLocaleUpperCase()`/`toLocaleLowerCase()`, `localeCompare()` and `Intl.*` are now client-only
markers, like `Date.now()`, unless the call names its locale (and, for dates, a `timeZone`), which
gives the same output everywhere. Library formatting the tool can't see into (`date-fns`' `format`)
remains a documented risk.

### Generated islands aren't scanned

A second run listed every generated `X.client.tsx` as a skip (`fully-interactive`,
`state-spans-component`), which buried the skips worth reading. Files whose name ends with
`clientFileSuffix` are islands and are no longer scanned by the CLI, the API or the ESLint rule.

### Smaller fixes

- The API's `config` option is validated like a config file; unknown keys used to be ignored.
- `--interactive` counted declined splits as split (`files split: 2 (1 written)`). The summary now
  counts the applied ones and lists the rest as `files declined`.
- A helper component moved whole into the island file keeps its own name; the README now says so.

## Unreleased — fewer manual steps, fewer skips

### Removing unused directives is opt-in

A `"use client"` file with no client-only code used to be skipped as `no-islands`, with a note
that the directive may be unnecessary. `removeUnusedDirectives` (and `--remove-unused-directives`)
now removes it. The analysis is the one a split gets up to the point where it finds no island:
importers (every one a server module rendering `<X />`), module-level code, env vars, side-effect
imports. The self-check runs on the result with no island file: no new diagnostics in the file or
its importers, no client-only code left, serializable props for every Client Component the file
renders. It stays off by default: a removed directive is a different kind of change from a split,
and a file can be marked `"use client"` on purpose (for example to keep a heavy component out of
the server bundle), which the analysis can't tell from an oversight.

`minBytesSaved` and `minStaticRatio` exist to keep small splits from adding a file and an import
for little gain. A removed directive adds nothing, so neither applies; the saving is still
estimated (the file's bundle against nothing, with the same shared-code accounting) and reported.
The result gets its own status, `"directive-removed"`, rather than `"split"` with no islands, so
JSON consumers and the summary can tell the two apart.

The ESLint rule gets its first fix for this case: it only edits the linted file. Splits stay
report-only (see [No autofix](#no-autofix)).

### Passes instead of "run it again"

The README used to ask users to rerun the tool until nothing new was split, because a split can
make another file splittable (a component imported only by a client component that is split). A
run now does that itself. Only files skipped as `imported-by-client` can change between passes, so
only they are held back and analysed again; every other result is reported when it's made. The
next pass applies the last pass's outputs to the same ts-morph project in memory, including the
new island files, and rebuilds the module graph with a resolution host that sees those files.
Nothing is written in between, so a dry run shows the final result, and each file is reported
once. Size estimates in later passes still bundle a candidate's imports from disk (esbuild's
synchronous API has no plugins to serve the in-memory files), which can only affect a dependency
shared with an earlier pass's split. Passes stop when one changes nothing, at 10 at most.

`--interactive` makes one pass: the user accepts each change separately, and a later pass would
assume the earlier changes were accepted. `rerun()` (used by interactive renames) refuses after a
multi-pass run, because later passes change the project the first pass analysed.

### Component values render on the server

next-learn's `nav-links.tsx` was skipped as `non-serializable-prop`: its links carry an icon
component (`icon: HomeIcon`) that the list item renders as `<LinkIcon className="w-6" />`. Two
changes split it:

- A static element that renders a component held in a variable (a parameter, a body variable or a
  callback variable) is a donut slot even when it's a single element. The function can't cross
  the boundary as a prop, but the rendered element can.
- Field picking also applies to objects that aren't serializable as a whole: when the island reads
  only fields that are (`link.href`, `link.name`), only those cross. Before, picking only made a
  serializable prop smaller.

### Smaller fixes

- A list item's `key` attribute on a line of its own no longer leaves a blank line in the island.
- `output-exists` and `would-create-route` are checked after the analysis, since a removed
  directive creates no file. A file with an existing island file and another problem now reports
  the other problem.

### An opt-out comment, not a config list

`removeUnusedDirectives` made one gap obvious: a file can be `"use client"` on purpose, and the
only way to say so was an `exclude` glob in the config, away from the code. An
`auto-server-split-ignore` comment sits next to the directive it explains, carries its reason
into the report, and survives renames. It's only read in the file header (before the first
import, or on the directive's line), so a comment deep in a component can't switch a file off by
accident. It's a skip (`ignored`) rather than a silent omission, so the summary still accounts for
every `"use client"` file, and size estimates don't assume an ignored file is split.

### Timezone risk is a warning, not a skip

Library date formatting moving to the server was a documented risk the tool didn't see. Making it
client-only, like `toLocaleString()`, would refuse most splits that move date-fns off the client,
which are among the largest savings (`PostCard` in the README). Most apps render in a fixed
timezone or format UTC dates where it doesn't matter, and the user is the one who knows. So
`timezone-dependent` is a warning: it names the call and its line, and the split goes ahead. It's
detected from types, not names: a date-fns function by where its declaration lives, a dayjs or
moment `.format()` by the receiver's type (unless `.tz()`, `.utc()` or `.utcOffset()` is in the
chain), and `Date`'s local getters on values typed `Date`. Code that stays in an island doesn't
warn, while code in a server-rendered slot does. date-fns-tz and the `getUTC*()` methods are
timezone-explicit and never warn.

### CI that fits existing apps

`--check` on a large app fails on every opportunity at once, which makes it hard to turn on. Two
ways to scope it: `--since <ref>` analyses only the files a branch changed (committed since it
forked, modified or untracked, from git), and a baseline file lists files to leave alone. Both
narrow the targets; a baselined file is also left out of the size estimates, since nobody is
going to split it. Changed-file detection uses `<ref>...HEAD` (the merge base), so a pull request
isn't charged for what landed on its base branch since it forked; that needs the base ref fetched,
and the error says so.

The GitHub output is the text output plus workflow-command annotations, not a separate report,
so the job log reads the same. Annotation paths are made relative to `GITHUB_WORKSPACE`, because
GitHub resolves them from the repository root while results are relative to the project root. The
action passes its inputs through environment variables, never into the script text, so an input
can't inject shell code.
