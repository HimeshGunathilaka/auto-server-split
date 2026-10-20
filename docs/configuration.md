# Configuration

`auto-split.config.ts`, `.mts`, `.mjs`, `.js` or `.json` in the project root (or `--config <file>`).
Options passed to the API (`split({ config })`) override the file.

| Key                      | Type              | Default                                            | Meaning                                                                                                                             |
| ------------------------ | ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `include`                | `string[]`        | `["app/**", "components/**", "src/**"]`            | Globs scanned when no paths are given.                                                                                              |
| `exclude`                | `string[]`        | `["**/*.test.*", "**/*.spec.*", "**/*.stories.*"]` | Globs never touched.                                                                                                                |
| `clientOnlyPackages`     | `string[]`        | `[]`                                               | Extra packages whose exports are client-only (`"@scope/*"` matches a scope). Added to the [built-in list](#built-in-package-lists). |
| `serverSafeHooks`        | `string[]`        | `[]`                                               | Hook names that work in Server Components and must not be treated as client-only (e.g. `useTranslations` with next-intl).           |
| `clientFileSuffix`       | `string`          | `".client"`                                        | `PostCard.tsx` → `PostCard.client.tsx`.                                                                                             |
| `islandsDir`             | `string`          | —                                                  | Put island files in a subdirectory (`components/_islands/PostCard.client.tsx`). Relative imports are rebased.                       |
| `minBytesSaved`          | `number`          | `2048`                                             | Skip splits whose conservative gzip saving is smaller (`below-threshold`), or can't be measured (`measure-failed`).                 |
| `minStaticRatio`         | `number`          | `0.3`                                              | Skip splits that keep a smaller share of the JSX on the server.                                                                     |
| `prettier`               | `"auto" \| false` | `"auto"`                                           | Format touched/generated files with the project's own Prettier, if it has a Prettier config inside the project root.                |
| `mongoose.autoSerialize` | `boolean`         | `false`                                            | Pass only the fields an island reads from Mongoose documents / ObjectId-bearing values (`String()` for ObjectIds).                  |

Unknown keys and invalid values are reported together, for example:

```
auto-split.config.json:
  - unknown key "colour" (allowed: include, exclude, …)
  - "minBytesSaved" must be a non-negative number
```

`.ts`/`.mts` configs are compiled with esbuild. `import { defineConfig } from "auto-server-split"` works
without the package being resolvable from the config's directory.

The ESLint rule reads the same file (any format, loaded synchronously), except a config that uses
top-level await, which it reports as an error. It doesn't see `--config`.

## Built-in package lists

An entry matches the package and its subpaths (`swr` also matches `swr/infinite`), `@scope/*`
matches every package in the scope, and an entry with a subpath (`next-auth/react`) matches only
that entry point. The lists are checked in this order: runtime CSS-in-JS, your
`clientOnlyPackages`, server-safe, built-in client-only. So `@radix-ui/react-icons` is server-safe
although `@radix-ui/*` is client-only.

**Client-only.** Anything imported from these stays in an island. Add your own with
`clientOnlyPackages`.

`framer-motion`, `motion`, `react-hook-form`, `@hookform/*`, `swiper`, `recharts`, `chart.js`, `react-chartjs-2`, `@tanstack/react-query`, `@tanstack/react-table`, `@tanstack/react-virtual`, `@tanstack/react-form`, `zustand`, `jotai`, `valtio`, `react-redux`, `@reduxjs/toolkit`, `mobx-react`, `mobx-react-lite`, `swr`, `@apollo/client`, `urql`, `react-hot-toast`, `react-toastify`, `sonner`, `@radix-ui/*`, `@headlessui/react`, `@floating-ui/react`, `@floating-ui/react-dom`, `@ariakit/react`, `react-aria`, `react-aria-components`, `react-select`, `react-dnd`, `react-dnd-html5-backend`, `@dnd-kit/*`, `react-beautiful-dnd`, `@hello-pangea/dnd`, `react-spring`, `@react-spring/*`, `@use-gesture/react`, `embla-carousel-react`, `keen-slider`, `react-slick`, `gsap`, `@gsap/react`, `lottie-react`, `@lottiefiles/react-lottie-player`, `react-confetti`, `react-countup`, `@react-three/fiber`, `@react-three/drei`, `three`, `react-leaflet`, `leaflet`, `mapbox-gl`, `react-map-gl`, `maplibre-gl`, `react-day-picker`, `react-datepicker`, `react-colorful`, `react-color`, `cmdk`, `vaul`, `react-dropzone`, `react-player`, `react-quill`, `@tiptap/react`, `slate-react`, `@lexical/react`, `react-intersection-observer`, `react-use`, `usehooks-ts`, `@uidotdev/usehooks`, `react-hotkeys-hook`, `react-modal`, `react-transition-group`, `react-window`, `react-virtualized`, `react-virtuoso`, `next-themes`, `@mantine/*`, `@chakra-ui/*`, `antd`, `@mui/*`, `react-bootstrap`, `@nextui-org/*`, `@heroui/*`, `react-i18next`, `@clerk/nextjs`, `next-auth/react`, `@supabase/auth-helpers-react`, `posthog-js`, `react-ga4`

**Server-safe.** React packages known to render correctly as Server Components. Every other package
that depends on React and has no `"use client"` entry is treated as client-only.

`@heroicons/react`, `@radix-ui/react-icons`

**Runtime CSS-in-JS.** A file that imports one is skipped (`css-in-js-runtime`).

`styled-components`, `@emotion/react`, `@emotion/styled`, `@emotion/css`, `@emotion/core`, `@stitches/react`, `goober`, `styled-jsx`, `styled-jsx/css`, `theme-ui`, `jss`, `react-jss`, `@linaria/react`, `styled-system`
