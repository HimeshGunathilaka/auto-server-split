# auto-server-split

**Split partly-interactive `"use client"` components into a Server Component plus small generated client islands, so the browser downloads less JavaScript, with no manual refactoring.**

For the Next.js App Router and React Server Components. It ships as a CLI codemod, a programmatic API and an ESLint plugin, all built on the same analysis engine. When the tool isn't sure a split is safe, it skips the file and tells you why.

## Before / after

```tsx
// PostCard.tsx (before)
"use client";
import { format } from "date-fns";
import { marked } from "marked";
import { useState } from "react";

type Post = { title: string; date: string; body: string };

export default function PostCard({ post }: { post: Post }) {
  const [liked, setLiked] = useState(false);
  return (
    <article>
      <h2>{post.title}</h2>
      <time>{format(new Date(post.date), "PPP")}</time>
      <div dangerouslySetInnerHTML={{ __html: marked(post.body) as string }} />
      <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>
    </article>
  );
}
```

```tsx
// PostCard.tsx (after): a Server Component; date-fns and marked no longer ship to the browser
import { format } from "date-fns";
import { marked } from "marked";
import { PostCardButton } from "./PostCard.client";

type Post = { title: string; date: string; body: string };

export default function PostCard({ post }: { post: Post }) {
  return (
    <article>
      <h2>{post.title}</h2>
      <time>{format(new Date(post.date), "PPP")}</time>
      <div dangerouslySetInnerHTML={{ __html: marked(post.body) as string }} />
      <PostCardButton />
    </article>
  );
}
```

```tsx
// PostCard.client.tsx (generated)
"use client";
import { useState } from "react";

export function PostCardButton() {
  const [liked, setLiked] = useState(false);
  return <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>;
}
```

In the e2e app that renders this component, the route ships **18.5 KB gzip less JavaScript**. The page's HTML is identical before and after, and the DOM stays identical after every click.

## Install

Node.js 20 or later. The analysis uses the TypeScript compiler that ships with the tool (via ts-morph), so it doesn't depend on your project's TypeScript version (tested with TypeScript 5 and 6 projects). Your project's own Prettier is used for formatting when it has a Prettier config.

```bash
npm install --save-dev auto-server-split     # or pnpm add -D / yarn add -D
npx auto-server-split --help
```

## Recommended workflow

1. **Start from a clean git state.** `--write` refuses to touch files with uncommitted changes, so commit or stash first. Every change the tool makes then shows up as one reviewable diff.
2. **Preview.** Start with one folder rather than the whole app:

   ```bash
   npx auto-server-split components
   ```

   Nothing is written. The output looks like this (abridged, colours removed):

   ```
   ✔ split components/ArticleFooter.tsx · 1 island · 83% static · ~83 B gzip saved (estimated)
       ArticleFooterButton <button>
   ===================================================================
   --- a/components/ArticleFooter.tsx
   +++ b/components/ArticleFooter.tsx
   @@ -1,4 +1,4 @@
   -"use client";
   +import { ArticleFooterButton } from "./ArticleFooter.client";
   …
   – skipped components/Badge.tsx [imported-by-client] imported by components/ClientPanel.tsx (client)
   – skipped components/Banner.tsx:6:5 [state-spans-component] client-only code is used across the whole returned tree (<div>, <small>: reads wide)

   Summary
     files scanned:  27 (21 with "use client")
     files split:    16 (dry run, nothing written)
     files skipped:  5
         1  imported-by-client             imported by a client module
         1  state-spans-component          client state spans the whole component
         …
     estimated saving: 727 B gzip of client JavaScript (1 split not measured)

   Run again with --write to apply.
   ```

3. **Apply.** Use `--write` to apply every split, or `--interactive` to accept, reject or rename them one at a time.
4. **Review before you commit.**
   - Read the diff: the rewritten `X.tsx` files and the new `X.client.tsx` files.
   - Run your build, type checker and tests.
   - Click through the affected pages, especially the interactive parts.
   - Check the `⚠ [timezone-dependent]` warnings. Date formatting that used to run in the browser (`format(date, "PPP")` or `formatISO()` from date-fns, `.format()` on a dayjs or moment value, `Date`'s local getters such as `getHours()`, and helpers from your own files that call them) now runs on the server, which may use a different timezone from your users' browsers. The tool flags the cases it recognises; look for others. (`toLocaleString()`, `Intl` and `localeCompare()` without an explicit locale stay in islands, and so do calls that read the current time, such as `formatDistanceToNow()` or `dayjs()`.)
5. **Chained splits are included.** Splitting a file can make another file splittable: a component that was only imported by a client component becomes splittable once that importer turns into a Server Component. A run analyses those files again, in memory, until nothing new changes, so one run (even a dry run) shows the whole result, and size estimates count a chain's changes together. Such a change is listed with the changes it `needs`, which have to be applied in the same run. `--interactive` makes a single pass, so run it again after accepting changes. The generated `X.client.tsx` files aren't scanned, so they never show up as skips.
6. **Look at the skips.** Some point to a small refactor that makes the file splittable (for example `exports-non-components` or `context-provider`). Others, such as `fully-interactive`, mean the component belongs on the client. `no-islands` means the file has no client-only code at all: pass `--remove-unused-directives` (or set `removeUnusedDirectives`) to have the tool remove its `"use client"`. [docs/skip-reasons.md](docs/skip-reasons.md) has a fix for each.
7. **Keep it from regressing** with the [ESLint rule](#eslint) in the editor and [`--check` in CI](#ci).

**Island names** are the component name followed by the island's root element in PascalCase: `PostCard` + `<button>` gives `PostCardButton`, and `<motion.div>` gives `PostCardMotionDiv`. When that name is already taken (by another island or a name in the file), a number is added (`ToolbarButton2`). A non-exported helper component that moves into the island file whole keeps its own name (`LikeButton`). Rename them with `[r]ename` in `--interactive` mode, or edit the generated file afterwards: it's ordinary source code, and the tool never writes into an existing `X.client.tsx`.

**To undo a split** before committing, restore the original file and delete the generated one:

```bash
git restore components/PostCard.tsx && rm components/PostCard.client.tsx
```

## CLI

```bash
npx auto-server-split <paths...> [--dry-run | --write | --check] [--interactive] [--format <f> | --json]
                                 [--since <ref>] [--baseline <file>] [--write-baseline <file>]
                                 [--config <file>] [--root <dir>] [--allow-dirty] [--verbose] [--no-measure]
                                 [--remove-unused-directives]
```

| Flag                         | What it does                                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(default)_ `--dry-run`      | Prints a coloured unified diff per file, the islands and the estimated KB saved. Skipped files show their reason. Nothing is written.                                                                                                                                                     |
| `--write`                    | Applies the changes. Refuses if any target file has uncommitted changes, is untracked or is git-ignored (or the project isn't a git repository), unless you pass `--allow-dirty`.                                                                                                         |
| `--check`                    | For CI: exits `2` if any split (or, with `--remove-unused-directives`, any directive removal) is available. Changes nothing.                                                                                                                                                              |
| `--allow-dirty`              | Lets `--write` and `--interactive` write files that have uncommitted changes, are untracked or git-ignored, or are outside a git repository.                                                                                                                                              |
| `--interactive`              | Walks through each proposed split: `[y]es / [n]o / [r]ename islands / [d]iff / [q]uit`, then writes the accepted ones (same git checks as `--write`). Renames go back through the engine and its self-check. Needs a terminal; can't be combined with `--dry-run`, `--json` or `--check`. |
| `--json`                     | Machine-readable report with the same shape as the API result.                                                                                                                                                                                                                            |
| `--format <f>`               | `text` (default), `json`, `markdown` (one report, for a pull request comment) or `github` (the text output plus [annotations](#ci) on the changed lines, and the markdown report appended to `$GITHUB_STEP_SUMMARY`).                                                                     |
| `--since <ref>`              | Only the files changed since a git ref (committed on this branch since it forked from `<ref>`, modified, or untracked), e.g. `--since origin/main` in a pull request. Size estimates still cover the whole project.                                                                       |
| `--baseline <file>`          | Leaves the files listed in a baseline file as they are: not analysed, and not assumed split by the estimates. For adopting `--check` in an existing app.                                                                                                                                  |
| `--write-baseline <file>`    | Writes the files that have a change available to a baseline file (`{ "files": [...] }`). Changes nothing else.                                                                                                                                                                            |
| `--config <file>`            | Config file (default: `auto-split.config.{ts,mts,mjs,js,json}` in the project root).                                                                                                                                                                                                      |
| `--root <dir>`               | Project root, where `tsconfig.json` lives (default: the current directory).                                                                                                                                                                                                               |
| `--no-measure`               | Skips the esbuild size measurement (faster; `minBytesSaved` isn't applied, and no saving is reported).                                                                                                                                                                                    |
| `--remove-unused-directives` | Also removes `"use client"` from files with no client-only code (`no-islands`), after the same checks as a split. Same as `removeUnusedDirectives: true` in the config. See [docs/configuration.md](docs/configuration.md#removeunuseddirectives).                                        |
| `--verbose`                  | Prints stack traces for internal errors.                                                                                                                                                                                                                                                  |
| `--help`, `--version`        | Usage and version.                                                                                                                                                                                                                                                                        |

Without paths, the config's `include` globs are used (`app/**`, `components/**`, `src/**`).
Exit codes: `0` ok, `1` internal error or bad input, `2` changes available (with `--check`).
The summary lists files scanned, files split, files skipped grouped by reason, and the total estimated saving
(see the sample output under [Recommended workflow](#recommended-workflow)).

### CI

`--check` exits `2` when a split is available, which fails the step:

```yaml
# .github/workflows/ci.yml (excerpt)
- run: npx auto-server-split --check
```

To report splits without failing the build, add `continue-on-error: true` to the step. The output lists each available split and its estimated saving either way.

On GitHub, the repository's action runs `--check --format github`: each available split gets an annotation on its file, each timezone warning a warning annotation, and the job summary gets the markdown report. It runs the project's own installed copy unless you set `version`; either must be 1.0.2 or later, and the action stops with an error otherwise.

```yaml
# .github/workflows/auto-split.yml
on: pull_request
jobs:
  auto-split:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --since needs the base branch
      - uses: actions/setup-node@v4
      - run: npm ci
      - uses: HimeshGunathilaka/auto-server-split@v1.0.2 # a release tag or commit SHA
        with:
          since: origin/${{ github.base_ref }} # only the files this pull request changes
          # working-directory: apps/web
          # baseline: auto-split.baseline.json
          # fail-on-changes: false
          # args: --remove-unused-directives
```

**Adopting `--check` in an existing app.** Record today's opportunities with `npx auto-server-split --write-baseline auto-split.baseline.json`, commit the file, and pass `--baseline auto-split.baseline.json` (the action's `baseline` input) in CI. Only new opportunities fail the check. Regenerate the file as you apply the listed ones. `--since` is the other way to scope CI: it checks only the files a pull request touches.

## API

```ts
import { split } from "auto-server-split";

const result = await split({
  root: process.cwd(), // project root (where tsconfig.json lives)
  paths: ["app", "components"],
  write: false,
  config: {}, // overrides the config file
});

for (const file of result.files) {
  console.log(file.file, file.status, file.skipped?.code, file.bytesSaved?.conservative);
}
```

See [docs/api.md](docs/api.md) for the full result type.

## ESLint

```js
// eslint.config.js
import tseslint from "typescript-eslint";
import autoSplit from "auto-server-split/eslint";

export default [
  ...tseslint.configs.recommended, // or any config that parses TypeScript/JSX
  autoSplit.configs.recommended,
];
```

The rule `auto-server-split/prefer-server-split` reports on the `"use client"` directive:

```
PostCard is 80% static with 1 interactive island (<button>). Check first (line 13): format() from date-fns uses the timezone of the machine that renders it, which is now the server; format with an explicit timezone (date-fns-tz's formatInTimeZone) or keep it in an island. Run: npx auto-server-split app/blog/PostCard.tsx --write
```

It applies the same config file, self-check and size thresholds as the CLI, so it only reports files the CLI would split. Splits have no autofix, because a split creates a new file and ESLint fixes can't do that. The CLI is the fixer. With `removeUnusedDirectives` in the config, the rule also reports unnecessary `"use client"` directives, and those it fixes (`eslint --fix`), unless the change has a warning: then removing the directive is an editor suggestion, so `--fix` and fix-on-save leave it for you to check. See [docs/eslint.md](docs/eslint.md).

## Configuration

```ts
// auto-split.config.ts
import { defineConfig } from "auto-server-split";

export default defineConfig({
  include: ["app/**", "components/**", "src/**"],
  exclude: ["**/*.test.*", "**/*.stories.*"],
  clientOnlyPackages: ["my-ui-lib/interactive"], // added to the built-in list
  serverSafePackages: [], // e.g. ["my-icon-lib"]
  serverSafeHooks: [], // e.g. ["useTranslations"]
  clientFileSuffix: ".client", // or islandsDir: "_islands"
  minBytesSaved: 2048, // gzip bytes, conservative estimate
  minStaticRatio: 0.3,
  prettier: "auto", // format touched files with the project's Prettier config
  mongoose: { autoSerialize: false },
  removeUnusedDirectives: false, // remove "use client" from files with no client-only code
});
```

Unknown keys are an error, in a config file and in the API's `config` option. See [docs/configuration.md](docs/configuration.md).

**Opting a file out.** A comment in the file header leaves that file alone in the CLI, the API, the size estimates and the ESLint rule. It's reported as a skip (`ignored`) with the reason you give:

```tsx
"use client"; // auto-server-split-ignore: keeps the chart library out of the server bundle
```

## Skip reasons

Every skip has a stable code, a one-sentence message and, where possible, a source location.
[docs/skip-reasons.md](docs/skip-reasons.md) has an example and a fix for each.

| Code                                     | When                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `imported-by-client`                     | A client module imports the file (directly or through a barrel)                                             |
| `exports-non-components`                 | The file exports hooks, utilities or values                                                                 |
| `state-spans-component`                  | Client state is used across the whole returned element                                                      |
| `context-provider`                       | The file creates or provides a Context                                                                      |
| `css-in-js-runtime`                      | styled-components, Emotion, styled-jsx…                                                                     |
| `non-serializable-prop`                  | A value crossing the boundary isn't serializable                                                            |
| `untyped-boundary`                       | `.js`/`.jsx` file and the prop types can't be proven                                                        |
| `spread-props`                           | A spread that can't be proven serializable                                                                  |
| `conditional-hooks-or-returns`           | Conditional hooks, or early returns that depend on client state                                             |
| `class-component`                        | The file contains a class component                                                                         |
| `dynamic-import` / `render-prop` / `hoc` | `next/dynamic`/`lazy`/`import()`, render props, `memo`/`forwardRef`                                         |
| `server-env-difference`                  | Reads a non-`NEXT_PUBLIC_` env var                                                                          |
| `no-islands` / `fully-interactive`       | No client code at all (`removeUnusedDirectives` removes the directive), or nothing would stay on the server |
| `below-threshold`                        | Below `minBytesSaved` or `minStaticRatio`                                                                   |
| `measure-failed`                         | esbuild couldn't bundle the file, so `minBytesSaved` can't be checked                                       |
| `output-exists` / `would-create-route`   | File-system conflicts                                                                                       |
| `unsupported-pattern`                    | Valid code this version doesn't handle, or an importer it can't verify (the message says which)             |
| `self-check-failed`                      | The generated code failed the self-check                                                                    |
| `parse-error` / `internal-error`         | Bugs: reported per file, never crash the run                                                                |
| `ignored`                                | The file opts out with an `auto-server-split-ignore` comment                                                |

## How it decides

1. **Module graph.** Every file the tsconfig covers, plus every other source and MDX file under the root (files the tsconfig excludes, `.js` without `allowJs`), with static imports, re-exports, `import()` and `next/dynamic`. Anything reachable from a `"use client"` module is client code.
2. **Candidates.** A `"use client"` file is a candidate only if every importer is a server module that renders its components as `<X />`, it exports only components and types, and nothing at module level behaves differently on the server. Importers outside the TypeScript project are checked without type information; when their usage can't be verified (an MDX file, `require()`), the file is skipped as `unsupported-pattern`.
3. **Client-only marking.** Hooks, event/ref/function props, browser globals, client-only packages (framer-motion, Radix, react-hook-form…), render nondeterminism (`Date.now()`, `Math.random()`, and date-library calls that read the current time, such as `formatDistanceToNow()`, `isToday()` or `dayjs()`), locale-dependent formatting (`toLocaleString()`, `Intl.*`, `localeCompare()`, unless the call names its locale and, for dates, its `timeZone`), and anything that can't be proven server-safe (unknown React packages, local modules that use hooks) are client-only. Taint propagates through the component body to a fixpoint.
4. **Islands.** Elements that use client-only code are anchors. Anchors that share state merge (union-find), the island root is their lowest common ancestor, and an escape check grows the island until no client value is read outside it. In `.map()` lists, the mapped element becomes a per-item island, unless that would duplicate component-level state. Effects join the island whose state they use. Static, non-trivial subtrees inside an island stay on the server as `children` ("donut"), and so does an element that renders a component held in a variable (`<LinkIcon />` with `const LinkIcon = link.icon`), since the component itself can't cross as a prop. In a file with several components, a non-exported helper component that is entirely interactive moves into the island file whole.
5. **Boundary.** Free variables become props and are proven serializable with the type checker (React's rules: primitives, plain objects, arrays, `Date`, `Map`, `Set`, typed arrays, Promises, JSX, Server Actions). Non-serializable helpers are copied into the island instead. When an island reads only some fields of an object, only those cross: `post={{ date: post.date }}`. That also lets an object that holds functions cross, when the island reads only its serializable fields.
6. **Rewrite.** magic-string range edits keep every untouched byte of the original. Imports move, are copied or are pruned, and the island file is generated in the original's quote, semicolon and indentation style. Prettier runs only when the project has a config and the original file is already formatted with it, so it can't rewrite lines the split didn't touch. Inserted lines and the island file use the original file's line ending (CRLF or LF, taken from its first line), with or without Prettier; a file that already mixes the two keeps its existing lines as they are.
7. **Self-check.** Before anything is reported or written, the output is typechecked in memory, re-analysed (no client code may remain in the server file), and every prop is re-checked. The typecheck allows no _new_ diagnostics: errors the file already had are tolerated, and diagnostics are compared by code and message. `.js`/`.jsx` files only get semantic checks when `checkJs` is on (never with a `jsconfig.json`), so for them this step is mostly a parse check.
8. **Measure.** The original file and the island file are bundled with esbuild (react/next external) and the gzip sizes compared. The estimate assumes every split the tool proposes for the project is applied (the run's own and those of the other `"use client"` files in `include`), so it doesn't depend on which paths you pass. The conservative number leaves out dependencies that other client modules would still ship, and a dependency that several splits remove together is counted once, divided between them: the output names those other splits ("assumes components/LintA.tsx is split too"). Splits below `minBytesSaved` are dropped until the rest still pass without them. If esbuild can't bundle a file, the saving is unknown: the file is skipped (`measure-failed`) unless `minBytesSaved` is 0, in which case it's split and labelled "saving not measured".
9. **Next pass.** Files skipped as `imported-by-client` are analysed again against the outputs so far (in memory, nothing is written in between) until a pass changes nothing. With `removeUnusedDirectives`, a file with no client-only code loses its directive after steps 1–2 and 7, and its saving is reported without applying the thresholds.

## Limitations

- **It's conservative.** On three well-known open-source apps, most `"use client"` files are skipped, because they are already genuinely interactive ([docs/benchmarks.md](docs/benchmarks.md)). The tool pays off in codebases that put `"use client"` high in the tree.
- **Server vs browser rendering differences** stay a risk: timezone-dependent formatting moves from the browser to the server (`format(new Date(x), "PPP")` in the example above). The tool warns about the calls it recognises (`[timezone-dependent]`: date-fns formatting and calendar functions, dayjs/moment `.format()` without `.tz()`/`.utc()`, `Date`'s local getters, also inside functions imported from your own files) but doesn't refuse them, and other libraries go unnoticed. Calls it _can_ see are kept on the client: nondeterministic ones (`Date.now()`, `Math.random()`, `new Date()`, and date-fns, dayjs or moment calls that read the current time) and locale-dependent ones (`toLocaleString()`, `Intl.*`, `localeCompare()` without an explicit locale).
- **Size estimates are project-wide**, not per route: code that any remaining client module imports counts as still shipped, even on routes that don't use that module. A page that only uses the split components can save more than the estimate.
- **Safety of local modules is decided per module, not per export**, so one client-only helper in a utility module keeps every caller of that module on the client.
- Third-party React packages are client-only unless they have a `"use client"` entry or are on the small built-in server-safe list. Unknown packages stay in islands.
- Not handled yet (they skip): class components, `memo`/`forwardRef`, render props, `next/dynamic`, Context providers, runtime CSS-in-JS, statements other than declarations/hook calls/early returns in a component body, and existing `X.client.tsx` files (it never merges).
- The ESLint rule caches the module graph and config per lint process, and can't load a config file that uses top-level await (rules are synchronous). It reads the config file the CLI finds by default, not one passed with `--config`.
- "Same rendered output" is enforced by the analysis rules, not re-checked on every run. The e2e suite checks it on two sample apps (identical server HTML, identical DOM after every interaction).
- Next.js only for now; framework specifics live in `src/frameworks/next.ts`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout, tests and release checklist.

## License

[MIT](LICENSE) © Himesh Gunathilake
