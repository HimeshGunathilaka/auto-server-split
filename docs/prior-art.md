# Prior art

Searched on 2026-10-19 (npm search and web search). Terms used: "use client codemod", "client boundary",
"server component split", "RSC islands", "client component extraction", "use client eslint", plus
general web searches for codemods and lint rules that split `"use client"` components.

**Result: nothing found that automatically splits a `"use client"` component into a server component
plus generated client islands.** The closest projects are listed below.

## Tools that come close

| Project | What it does | Why it is different |
|---|---|---|
| [Blazity/next-migration-skills](https://github.com/Blazity/next-migration-skills) (`component-migration` skill) | Agent skill that tells an AI coding agent to "extract the interactive part into a separate client component". Its bundled `ast-tool.ts` only analyzes components and validates results. | Instructions for an LLM agent, not a deterministic codemod. No safety analysis of the boundary. |
| [shiftyp/react-component-compiler](https://github.com/shiftyp/react-component-compiler) | Describes identifying client vs server components by AST analysis and splitting code automatically. | A concept/proposal; no working implementation. |
| [NaverPayDev/eslint-plugin-use-client](https://github.com/NaverPayDev/eslint-plugin-use-client) | ESLint rule that reports files that *need* `"use client"` (hooks, browser APIs, handlers) and can add it. | The inverse problem: adds the directive, never removes or splits. |
| [eslint-plugin-react-rsc](https://github.com/Rel1cx/eslint-react) (eslint-react) | RSC-related lint rules (directive placement and similar). | Reports misuse; does not detect or perform splits. |
| [TanStack Start `no-client-code-in-server-component`](https://tanstack.com/start/latest/docs/eslint/no-client-code-in-server-component) | Lint rule that flags hooks / `window` inside server components. | Reverse direction; no extraction. |
| [`@next/next/no-async-client-component`](https://nextjs.org/docs/app/api-reference/config/eslint) / Biome `noNextAsyncClientComponent` | Flags `async` client components. | Unrelated check on client files. |
| [`@arch-lens/plugin-next`](https://www.npmjs.com/package/@arch-lens/plugin-next) | Validates server/client boundaries for the arch-lens architecture tool. | Validation only. |

## Related guidance (manual pattern this tool automates)

- [React docs: `'use client'`](https://react.dev/reference/rsc/use-client): the directive marks a boundary in the module graph; every transitive import becomes client code.
- [Next.js docs: Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components): "add `'use client'` to specific interactive components instead of marking large parts of your UI as Client Components".
- [Gatsby partial hydration guide](https://github.com/gatsbyjs/gatsby/blob/d3b38468d54bd57e625954af29f3101df5388ce5/docs/docs/how-to/performance/partial-hydration.md): move client components to the leaves of the tree.

## Conclusion

No existing tool does what `auto-server-split` sets out to do, so building it does not duplicate prior work.
