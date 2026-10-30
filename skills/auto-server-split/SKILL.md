---
name: auto-server-split
description: Shrink a Next.js App Router app's client JavaScript by splitting partly-interactive "use client" components into Server Components plus small client islands with the deterministic auto-server-split codemod. Use when asked to reduce client bundle size, move code to Server Components, fix oversized "use client" boundaries, or act on next-bundle-optimizer / `next analyze` findings about client components.
---

# auto-server-split

`auto-server-split` rewrites a `"use client"` component into a Server Component plus generated
`X.client.tsx` islands, and only when it can prove the result is safe (importers, serializable
props, a type-checked self-check). Let the tool do every rewrite at a client boundary. Your job is
to run it, read what it says, make the small refactors it asks for, and verify.

## Workflow

1. **Check the starting state.** Work from a clean git tree (`--write` refuses dirty files). Check
   that the app type-checks and builds before you change anything, so failures afterwards are
   yours to explain.

2. **See what's available.** Run a dry run and read the JSON:

   ```bash
   npx auto-server-split --json > auto-split.before.json
   ```

   - `files[].status` is `split`, `directive-removed` or `skipped`.
   - `skipped.code` is a stable reason.
   - `routes` and `summary.bestRoute` show where the savings land.
   - `warnings` lists risks to tell the user about. `timezone-dependent` means date formatting
     moves to the server's timezone.

3. **Apply the safe changes.** Run:

   ```bash
   npx auto-server-split --write
   ```

   - Don't edit the generated islands, except to rename them.
   - Don't hand-split files the tool split.
   - Show the user the diff and the warnings.

4. **Work through the skips, one file at a time.** For each skip worth fixing, run:

   ```bash
   npx auto-server-split --explain <file>
   ```

   It prints the element-by-element reasons, how the islands were formed, and a suggestion. Make
   only the small, behaviour-preserving refactor the skip calls for, then run `--write` on that
   file again. Match the skip code:

   | Skip code                                    | What to do                                                                                                                                                      |
   | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `exports-non-components`                     | Move the exported hooks, helpers or constants into their own module, then update their imports.                                                                 |
   | `context-provider`                           | Move `createContext` and the provider into a small `"use client"` file and render it from the component (the suggestion names the files).                       |
   | `state-spans-component`                      | Extract the interactive region into its own component in the same file, or move the state next to the elements that use it.                                     |
   | `imported-by-client`                         | Render the component from a Server Component, or pass it to the client parent as `children`. Often the parent gets split first; the tool's passes pick that up. |
   | `hoc` (a used `forwardRef` ref)              | Leave it. In React 19 you may replace `forwardRef` with a `ref` prop, but only if the user wants that change.                                                   |
   | `fully-interactive`, `no-islands`, `ignored` | Leave the file. `no-islands` can be applied with `--remove-unused-directives` if the user agrees.                                                               |
   | `self-check-failed`, `internal-error`        | Don't work around it. Report it with the message.                                                                                                               |

   Never remove `"use client"`, move hooks or rewrite boundaries by hand to "help" the tool. If the
   tool can't prove a change, the change isn't safe.

5. **Run the analysis again** until nothing new changes:

   ```bash
   npx auto-server-split --json > auto-split.after.json
   npx auto-server-split compare auto-split.before.json auto-split.after.json
   ```

6. **Verify.** Use `npx auto-server-split verify` when the config has `verify.commands`. Otherwise
   run the project's type checker, tests and build yourself. If something fails, restore the files
   of the change that caused it, with `git restore <file>` and by deleting its `X.client.tsx`.

7. **Measure.** In a Next.js 16.4+ app:

   ```bash
   npx next analyze --output
   npx auto-server-split --analyze-snapshot . --json
   ```

   This gives per-route numbers from Next's analyzer. Report the saving per route and the warnings.

## Rules

- Keep each change reviewable: one `--write` per batch, not mixed with unrelated edits.
- Report `timezone-dependent` and `rule` warnings to the user. Don't silence them.
- Don't raise `minBytesSaved` or lower other thresholds unless the user asks.
- Don't add `auto-server-split-ignore` comments without the user's agreement; they hide files from
  the tool permanently.
