# auto-server-split

Split partly-interactive `"use client"` components into a Server Component plus small generated
client islands, so the browser downloads less JavaScript. No manual refactoring.

> Work in progress. The full README lands with 1.0. See `docs/skip-reasons.md` and `docs/decisions.md`.

```bash
npx auto-server-split app components          # dry run: prints the diff, writes nothing
npx auto-server-split app components --write  # apply
npx auto-server-split --check                 # CI: exit 2 if a split is available
```
