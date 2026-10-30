# CLI reference

The command-line interface: the recommended workflow, every flag, exit codes and monorepo support.
For CI, see [ci.md](ci.md).

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
6. **Look at the skips.** Some point to a small refactor that makes the file splittable (for example `exports-non-components` or `context-provider`). Others, such as `fully-interactive`, mean the component belongs on the client. `no-islands` means the file has no client-only code at all: pass `--remove-unused-directives` (or set `removeUnusedDirectives`) to have the tool remove its `"use client"`. [docs/skip-reasons.md](skip-reasons.md) has a fix for each, and `npx auto-server-split --explain components/Banner.tsx` explains one file:

   ```
   components/Banner.tsx  "use client" boundary
     rendered by: app/page.tsx:6
     – skipped components/Banner.tsx:6:5 [state-spans-component] client-only code is used across the whole returned tree (<div>, <small>: reads wide)
     (client state spans the whole component)
     elements that need the client:
       <div> (line 6): reads wide
       <small> (line 9): reads wide
     how the islands were formed:
       <div> (line 6) and <small> (line 9) share `wide` (line 4), so they're one island
       the island is <div> (line 6), the closest element around <div> (line 6), <small> (line 9)
     suggestion: keep the state next to the elements that use it, or extract the interactive region into its own component
   ```

   For a module without a directive it shows the shortest import chain that makes it client code, and whether a Server Component could import it (export by export). `--graph` lists every client boundary, the Server Components that render it and what it pulls into the browser bundle.

7. **Verify.** With `verify: { commands: ["pnpm typecheck", "pnpm test", "pnpm build"] }` in the config, `npx auto-server-split verify` runs them and reports what passed (it never rolls anything back).
8. **Keep it from regressing** with the [ESLint rule](eslint.md) in the editor, `--watch` while you work, and [`--check` in CI](ci.md).

**Island names** are the component name followed by the island's root element in PascalCase: `PostCard` + `<button>` gives `PostCardButton`, and `<motion.div>` gives `PostCardMotionDiv`. When that name is already taken (by another island or a name in the file), a number is added (`ToolbarButton2`). A non-exported helper component that moves into the island file whole keeps its own name (`LikeButton`). Rename them with `[r]ename` in `--interactive` mode, or edit the generated file afterwards: it's ordinary source code, and the tool never writes into an existing `X.client.tsx`.

**To undo a split** before committing, restore the original file and delete the generated one:

```bash
git restore components/PostCard.tsx && rm components/PostCard.client.tsx
```

## Commands and flags

```bash
npx auto-server-split <paths...> [--dry-run | --write | --check] [--interactive] [--watch]
                                 [--format <f> | --json] [--output <file>] [--analyze-snapshot <path>]
                                 [--since <ref>] [--baseline <file>] [--write-baseline <file>]
                                 [--workspace | --project <dir>...] [--config <file>] [--root <dir>]
                                 [--allow-dirty] [--verbose] [--no-measure] [--remove-unused-directives]
npx auto-server-split --explain <file> [--json]
npx auto-server-split --graph [--json]
npx auto-server-split verify [--keep-going] [--json] [--report <report.json>]
npx auto-server-split compare <before.json> <after.json> [--format text|json|markdown] [--fail-on-new]
```

| Flag                         | What it does                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(default)_ `--dry-run`      | Prints a coloured unified diff per file, the islands and the estimated KB saved. Skipped files show their reason. Nothing is written.                                                                                                                                                                                                                         |
| `--write`                    | Applies the changes. Refuses if any target file has uncommitted changes, is untracked or is git-ignored (or the project isn't a git repository), unless you pass `--allow-dirty`.                                                                                                                                                                             |
| `--check`                    | For CI: exits `2` if any split (or, with `--remove-unused-directives`, any directive removal) is available. Changes nothing.                                                                                                                                                                                                                                  |
| `--allow-dirty`              | Lets `--write` and `--interactive` write files that have uncommitted changes, are untracked or git-ignored, or are outside a git repository.                                                                                                                                                                                                                  |
| `--interactive`              | Walks through each proposed split: `[y]es / [n]o / [r]ename islands / [d]iff / [q]uit`, then writes the accepted ones (same git checks as `--write`). Renames go back through the engine and its self-check. Needs a terminal; can't be combined with `--dry-run`, `--json` or `--check`.                                                                     |
| `--json`                     | Machine-readable report with the same shape as the API result (`files`, `routes`, `summary`).                                                                                                                                                                                                                                                                 |
| `--format <f>`               | `text` (default), `json`, `markdown` (one report, for a pull request comment), `github` (the text output plus [annotations](ci.md#github-action) on the changed lines, and the markdown report appended to `$GITHUB_STEP_SUMMARY`), `sarif` (GitHub code scanning), `gitlab` (Code Quality) or `html` (a self-contained page with filters, routes and diffs). |
| `--output <file>`            | Writes the `--format` report to a file and prints the usual text output, e.g. `--format html --output auto-split.html`.                                                                                                                                                                                                                                       |
| `--explain <file>`           | Explains one file: the boundary and import chain that make it client code, why each element needs the client, how the islands were formed, what happens to each import, which routes it affects, and what to do about a skip. `--json` for the data.                                                                                                          |
| `--graph`                    | Lists every `"use client"` boundary, the Server Components that render it, the modules and packages it pulls into the browser bundle, and `"use client"` barrels that re-export modules which don't need the directive. `--json` for the data.                                                                                                                |
| `--watch`                    | Analyses, then again whenever a source file changes, printing only the results that changed. Writes nothing.                                                                                                                                                                                                                                                  |
| `--analyze-snapshot <path>`  | Takes per-route sizes from a [Next.js analyzer](https://nextjs.org/docs/app/guides/package-bundling) snapshot instead of esbuild estimates: the JSON Lines `next analyze export` prints, or the app (or `.next`) directory after `next analyze --output` (it runs `next analyze export`, which doesn't build).                                                |
| `--workspace`                | Runs on every Next.js App Router app of a pnpm, npm, Yarn or Bun workspace and reports them together (see [Monorepos](#monorepos)).                                                                                                                                                                                                                           |
| `--project <dir>`            | Runs on the apps you name (repeatable) instead of all of them.                                                                                                                                                                                                                                                                                                |
| `--since <ref>`              | Only the files changed since a git ref (committed on this branch since it forked from `<ref>`, modified, or untracked), e.g. `--since origin/main` in a pull request. Size estimates still cover the whole project.                                                                                                                                           |
| `--baseline <file>`          | Leaves the files listed in a baseline file as they are: not analysed, and not assumed split by the estimates. For adopting `--check` in an existing app.                                                                                                                                                                                                      |
| `--write-baseline <file>`    | Writes the available changes to a baseline file: their paths, fingerprints and estimated savings, every `"use client"` file (with a hash of its code, so a moved or renamed one still matches), and the totals. Changes nothing else.                                                                                                                         |
| `--config <file>`            | Config file (default: `auto-split.config.{ts,mts,mjs,js,json}` in the project root).                                                                                                                                                                                                                                                                          |
| `--root <dir>`               | Project root, where `tsconfig.json` lives (default: the current directory).                                                                                                                                                                                                                                                                                   |
| `--no-measure`               | Skips the esbuild size measurement (faster; `minBytesSaved` isn't applied, and no saving is reported).                                                                                                                                                                                                                                                        |
| `--remove-unused-directives` | Also removes `"use client"` from files with no client-only code (`no-islands`), after the same checks as a split. Same as `removeUnusedDirectives: true` in the config. See [docs/configuration.md](configuration.md#removeunuseddirectives).                                                                                                                 |
| `--verbose`                  | Prints stack traces for internal errors.                                                                                                                                                                                                                                                                                                                      |
| `--help`, `--version`        | Usage and version.                                                                                                                                                                                                                                                                                                                                            |

Without paths, the config's `include` globs are used (`app/**`, `components/**`, `src/**`).
Exit codes: `0` ok, `1` internal error or bad input (or a failed `verify` command), `2` changes available (with `--check`) or a [budget](configuration.md#check) exceeded.
The summary lists files scanned, files split, files skipped grouped by reason, the total estimated saving and the
routes affected (see the sample output under [Recommended workflow](#recommended-workflow)). Each change lists the
App Router routes that load it and what it saves on each: `routes: / ~9.7 KB, /about ~94 B`.

## Monorepos

`npx auto-server-split --workspace` finds the Next.js App Router apps of a pnpm, npm, Yarn or Bun workspace (Turborepo uses the same workspaces) and runs on each with its own `tsconfig.json`, `next.config` and `auto-split.config.*`; `--project apps/web` names them instead, and `projects` in the root config lists them as globs. Results are relative to the workspace root (`apps/web/components/Card.tsx`, routes as `apps/web:/`), so every report format works across apps. Shared packages aren't changed (another app may import the same component), but their source is analysed as part of each app: a workspace package's server-safe component can stay on the server.
