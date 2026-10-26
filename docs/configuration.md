# Configuration

`auto-split.config.ts`, `.mts`, `.mjs`, `.js` or `.json` in the project root (or `--config <file>`).
Options passed to the API (`split({ config })`) override the file.

| Key                      | Type              | Default                                            | Meaning                                                                                                                                                           |
| ------------------------ | ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `include`                | `string[]`        | `["app/**", "components/**", "src/**"]`            | Globs scanned when no paths are given.                                                                                                                            |
| `exclude`                | `string[]`        | `["**/*.test.*", "**/*.spec.*", "**/*.stories.*"]` | Globs never touched.                                                                                                                                              |
| `clientOnlyPackages`     | `string[]`        | `[]`                                               | Extra packages whose exports are client-only (`"@scope/*"` matches a scope). Added to the [built-in list](#built-in-package-lists).                               |
| `serverSafePackages`     | `string[]`        | `[]`                                               | Extra React packages that render correctly as Server Components (e.g. an icon library). Overrides the built-in client-only list.                                  |
| `serverSafeHooks`        | `string[]`        | `[]`                                               | Hook names that work in Server Components and must not be treated as client-only (e.g. `useTranslations` with next-intl).                                         |
| `clientFileSuffix`       | `string`          | `".client"`                                        | `PostCard.tsx` → `PostCard.client.tsx`. Files whose name already ends with it are islands and aren't scanned.                                                     |
| `islandsDir`             | `string`          | —                                                  | Put island files in a subdirectory (`components/_islands/PostCard.client.tsx`). Relative imports are rebased.                                                     |
| `minBytesSaved`          | `number`          | `2048`                                             | Skip splits whose conservative gzip saving (estimated with the project's other splits) is smaller, or can't be measured.                                          |
| `minStaticRatio`         | `number`          | `0.3`                                              | Skip splits that keep a smaller share of the JSX on the server.                                                                                                   |
| `prettier`               | `"auto" \| false` | `"auto"`                                           | Format the output with the project's own Prettier, if it has a config inside the root and the original file is already formatted.                                 |
| `mongoose.autoSerialize` | `boolean`         | `false`                                            | Pass only the fields an island reads from Mongoose documents / ObjectId-bearing values (`String()` for ObjectIds).                                                |
| `removeUnusedDirectives` | `boolean`         | `false`                                            | Remove `"use client"` from files with no client-only code (see [below](#removeunuseddirectives)). The CLI's `--remove-unused-directives` turns it on for one run. |

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
