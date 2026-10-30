# Configuration

`auto-split.config.ts`, `.mts`, `.mjs`, `.js` or `.json` in the project root (or `--config <file>`).
Options passed to the API (`split({ config })`) override the file.

| Key                      | Type                    | Default                                            | Meaning                                                                                                                                                                                                            |
| ------------------------ | ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `include`                | `string[]`              | `["app/**", "components/**", "src/**"]`            | Globs scanned when no paths are given.                                                                                                                                                                             |
| `exclude`                | `string[]`              | `["**/*.test.*", "**/*.spec.*", "**/*.stories.*"]` | Globs never touched.                                                                                                                                                                                               |
| `clientOnlyPackages`     | `string[]`              | `[]`                                               | Extra packages whose exports are client-only (`"@scope/*"` matches a scope). Added to the [built-in list](#built-in-package-lists).                                                                                |
| `serverSafePackages`     | `string[]`              | `[]`                                               | Extra React packages that render correctly as Server Components (e.g. an icon library). Overrides the built-in client-only list.                                                                                   |
| `serverSafeHooks`        | `string[]`              | `[]`                                               | Hook names that work in Server Components and must not be treated as client-only (e.g. `useTranslations` with next-intl).                                                                                          |
| `clientFileSuffix`       | `string`                | `".client"`                                        | `PostCard.tsx` → `PostCard.client.tsx`. Files whose name already ends with it are islands and aren't scanned.                                                                                                      |
| `islandsDir`             | `string`                | —                                                  | Put island files in a subdirectory (`components/_islands/PostCard.client.tsx`). Relative imports are rebased.                                                                                                      |
| `minBytesSaved`          | `number`                | `2048`                                             | Skip splits whose conservative gzip saving (estimated with the project's other splits) is smaller, or can't be measured.                                                                                           |
| `minStaticRatio`         | `number`                | `0.3`                                              | Skip splits that keep a smaller share of the JSX on the server.                                                                                                                                                    |
| `prettier`               | `"auto" \| false`       | `"auto"`                                           | Format the output with the project's own Prettier, if it has a config inside the root and the original file is already formatted.                                                                                  |
| `mongoose.autoSerialize` | `boolean`               | `false`                                            | Pass only the fields an island reads from Mongoose documents / ObjectId-bearing values (`String()` for ObjectIds).                                                                                                 |
| `removeUnusedDirectives` | `boolean`               | `false`                                            | Remove `"use client"` from files with no client-only code (see [below](#removeunuseddirectives)). The CLI's `--remove-unused-directives` turns it on for one run.                                                  |
| `outputExists`           | `"skip" \| "alternate"` | `"skip"`                                           | What to do when `X.client.tsx` already exists: skip the file (`output-exists`), or use the first free `X.island.client.tsx`, `X.island2.client.tsx`, `X.island3.client.tsx`. Existing files are never merged into. |
| `rules`                  | `object`                | `{}`                                               | Declarative safety rules for packages, exports and calls (see [below](#rules)).                                                                                                                                    |
| `check`                  | `object`                | `{}`                                               | What fails `--check`: per-change thresholds and budgets (see [below](#check)).                                                                                                                                     |
| `verify`                 | `{ commands }`          | —                                                  | Commands `auto-server-split verify` runs (see [below](#verify)).                                                                                                                                                   |
| `projects`               | `string[]`              | —                                                  | In a workspace root's config: the apps `--workspace` runs on (globs). Without it, the workspace's Next.js App Router apps are found (see [below](#workspaces)).                                                    |

Unknown keys and invalid values are reported together, for example:

```
auto-split.config.json:
  - unknown key "colour" (allowed: include, exclude, …)
  - "minBytesSaved" must be a non-negative number
```

The API's `config` option is checked the same way.

`.ts`/`.mts` configs are compiled with esbuild. `import { defineConfig } from "auto-server-split"` works
without the package being resolvable from the config's directory.

The ESLint rule reads the same file (any format, loaded synchronously), except a config that uses
top-level await, which it reports as an error. It doesn't see `--config`.

## `removeUnusedDirectives`

A `"use client"` file whose components use no client-only code is skipped as `no-islands`: nothing
needs to move into an island, and the directive itself may be unnecessary. With
`removeUnusedDirectives: true`, the tool removes the directive instead, and the file becomes a
Server Component as it is. The result has the status `"directive-removed"`, and no island file is
created.

It applies the checks a split does: every importer is a server module that renders the components
as `<X />`, nothing at module level behaves differently on the server, and the self-check
typechecks the result and confirms that no client-only code is left and that every prop passed to
a Client Component is serializable. `minBytesSaved` and `minStaticRatio` don't apply, because no
file is created; the saving is still estimated and reported.

It's off by default, because the result is a different kind of change from a split, and a file
can be marked `"use client"` for a reason the analysis can't see (for example, to keep it out of
the server bundle).

## Built-in package lists

An entry matches the package and its subpaths (`swr` also matches `swr/infinite`), `@scope/*`
matches every package in the scope, and an entry with a subpath (`next-auth/react`) matches only
that entry point. The lists are checked in this order: runtime CSS-in-JS, your
`clientOnlyPackages`, your `serverSafePackages`, built-in server-safe, built-in client-only. So
`@radix-ui/react-icons` is server-safe although `@radix-ui/*` is client-only. An entry point that
starts with `"use client"` is a Client Component reference even in a server-safe package
(`lucide-react/dynamic`).

**Client-only.** Anything imported from these stays in an island. Add your own with
`clientOnlyPackages`.

`framer-motion`, `motion`, `react-hook-form`, `@hookform/*`, `swiper`, `recharts`, `chart.js`, `react-chartjs-2`, `@tanstack/react-query`, `@tanstack/react-table`, `@tanstack/react-virtual`, `@tanstack/react-form`, `zustand`, `jotai`, `valtio`, `react-redux`, `@reduxjs/toolkit`, `mobx-react`, `mobx-react-lite`, `swr`, `@apollo/client`, `urql`, `react-hot-toast`, `react-toastify`, `sonner`, `@radix-ui/*`, `@headlessui/react`, `@floating-ui/react`, `@floating-ui/react-dom`, `@ariakit/react`, `react-aria`, `react-aria-components`, `react-select`, `react-dnd`, `react-dnd-html5-backend`, `@dnd-kit/*`, `react-beautiful-dnd`, `@hello-pangea/dnd`, `react-spring`, `@react-spring/*`, `@use-gesture/react`, `embla-carousel-react`, `keen-slider`, `react-slick`, `gsap`, `@gsap/react`, `lottie-react`, `@lottiefiles/react-lottie-player`, `react-confetti`, `react-countup`, `@react-three/fiber`, `@react-three/drei`, `three`, `react-leaflet`, `leaflet`, `mapbox-gl`, `react-map-gl`, `maplibre-gl`, `react-day-picker`, `react-datepicker`, `react-colorful`, `react-color`, `cmdk`, `vaul`, `react-dropzone`, `react-player`, `react-quill`, `@tiptap/react`, `slate-react`, `@lexical/react`, `react-intersection-observer`, `react-use`, `usehooks-ts`, `@uidotdev/usehooks`, `react-hotkeys-hook`, `react-modal`, `react-transition-group`, `react-window`, `react-virtualized`, `react-virtuoso`, `next-themes`, `@mantine/*`, `@chakra-ui/*`, `antd`, `@mui/*`, `react-bootstrap`, `@nextui-org/*`, `@heroui/*`, `react-i18next`, `@clerk/nextjs`, `next-auth/react`, `@supabase/auth-helpers-react`, `posthog-js`, `react-ga4`

**Server-safe.** React packages known to render correctly as Server Components. Every other package
that depends on React and has no `"use client"` entry is treated as client-only. Add your own with
`serverSafePackages`.

`@heroicons/react`, `@radix-ui/react-icons`, `@tabler/icons-react`, `lucide-react`

**Runtime CSS-in-JS.** A file that imports one is skipped (`css-in-js-runtime`).

`styled-components`, `@emotion/react`, `@emotion/styled`, `@emotion/css`, `@emotion/core`, `@stitches/react`, `goober`, `styled-jsx`, `styled-jsx/css`, `theme-ui`, `jss`, `react-jss`, `@linaria/react`, `styled-system`

## `rules`

The package lists above classify whole packages. `rules` can also name single exports and calls,
so a package doesn't need a new release of this tool to be classified:

```ts
rules: {
  clientOnlyImports: ["my-ui/interactive", "my-utils#useViewport"],
  serverSafeExports: ["my-icons", "my-ui#Icon"],
  browserDependentCalls: ["my-dates#today", "performance.now"],
  warnings: [{ call: "my-intl#formatMoney", message: "it formats in the server's locale" }],
},
```

| Key                     | Entries                                                   | Meaning                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientOnlyImports`     | `"package"`, `"@scope/*"`, `"pkg/sub"` or `"pkg#export"`  | Client-only. A package entry is the same as `clientOnlyPackages`; `pkg#export` makes just that export client-only (using it keeps code in an island).                                 |
| `serverSafeExports`     | `"package"` or `"pkg#export"`                             | Renders correctly as a Server Component. A package entry is the same as `serverSafePackages`; `pkg#export` covers one export of a package that is otherwise unknown or client-only.   |
| `browserDependentCalls` | `"pkg#export"` (an imported function) or a global path    | Calls whose result differs between the server and the browser, kept in islands like `Date.now()`. A global path is matched as written: `"performance.now"`, `"Temporal.Now.instant"`. |
| `warnings`              | `{ call, message }`, `call` as in `browserDependentCalls` | A change in which such a call moves to the server carries a `rule` warning with your message. The change isn't refused.                                                               |

`pkg#export` matches a named import (`import { today } from "pkg"`), a member of a namespace import
(`dates.today()`), or `default`. Client-only rules win over server-safe ones. A server-safe rule
can't make React, `react-dom`, Next.js modules, Node built-ins or a `"use client"` entry point
server-safe.

## `check`

Without settings, `--check` fails (exit `2`) when any change is available. `check` changes that:

```ts
check: {
  minSaving: 4096, // only changes that save at least 4 KB gzip fail the check...
  minRouteSaving: 2048, // ...or that save at least 2 KB up front on one route
  maxRecoverable: 20_000, // also fail when the available changes together save more than this
  maxNewBoundaries: 0, // also fail when a "use client" file isn't in the baseline
},
```

| Key                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minSaving`        | A change fails the check only if its estimated saving (conservative, gzip bytes) is at least this.                                                                                                                                                                                                                                                                                                                                                                                        |
| `minRouteSaving`   | ...or if it saves at least this up front on one App Router route. With both set, either is enough.                                                                                                                                                                                                                                                                                                                                                                                        |
| `maxRecoverable`   | Fail when the available changes together save more than this (a budget for client JavaScript left on the table).                                                                                                                                                                                                                                                                                                                                                                          |
| `maxNewBoundaries` | Fail when more `"use client"` files than this aren't in the baseline (`--baseline`, written by `--write-baseline` 1.0.3 or later, which records every `"use client"` file). Without such a baseline, `--check` stops with an error. A file that moved or was renamed isn't new: it matches a baseline file that's gone by its change, its file name or its code (imports aside). Files named `*.client.*`, where islands are written, aren't counted, so applying a split never fails it. |

A budget (`maxRecoverable`, `maxNewBoundaries`) set without `minSaving`/`minRouteSaving` replaces
the any-change rule: only the budget fails the check. Changes in the baseline never count. The
summary says which rule failed (`✗ the available changes save 24.1 KB, more than maxRecoverable`);
with a report format (`--json`, `--format sarif`…) that line goes to stderr.

## `verify`

```ts
verify: { commands: ["pnpm typecheck", "pnpm test", "pnpm build"] },
```

`auto-server-split verify` runs these commands in the project root through the shell, one after
another, and stops at the first that fails (`--keep-going` runs them all). It's a separate
command, run when you choose, usually after `--write`; nothing runs on its own and nothing is
rolled back. `--json` prints the result (each command's exit code, duration and the tail of its
output); `--report report.json` adds it, output tails included, to a JSON report as `verification`
(the report is checked before anything runs). It exits `1` when a command fails.

## Workspaces

`--workspace` runs on every Next.js App Router app in a pnpm, npm, Yarn or Bun workspace (from
`pnpm-workspace.yaml` or `package.json` `workspaces`; Turborepo uses these too): each app is a
separate run with its own `tsconfig.json`, `next.config` and `auto-split.config.*`, and the results
are reported together, relative to the workspace root (`apps/web/components/Card.tsx`, routes as
`apps/web:/`). `--project apps/web` (repeatable) runs on the apps you name instead. `projects` in
the root config lists them as globs. A glob runs on the Next.js App Router apps it matches; a
directory named outright (`--project apps/web`, `--project .`) has to be one, or the run stops.

Shared packages (`packages/ui`) aren't runs of their own: several apps can import a component, and
a run of one app can't see the others' importers. Their source is still analysed as part of each
app that imports it: a package linked into `node_modules` (a workspace package) whose real path is
project source, and whose `exports`/`main` entry is that same source, is treated like the app's own
modules, so a server-safe component from it can stay
on the server instead of being judged by its `package.json`. TypeScript project
references aren't followed: each app is analysed with its own `tsconfig.json`, and a package is read
from the source its imports resolve to.
