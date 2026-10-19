/**
 * Everything framework-specific lives behind this interface so `analysis/` stays framework-neutral.
 * The Next.js implementation is `src/frameworks/next.ts`.
 */

/** How one imported binding behaves once the importing code runs as a Server Component. */
export type BindingClass =
  /** Safe on the server and on the client (pure functions, data, icons...). */
  | "neutral"
  /** Must stay in client code (state, effects, browser APIs, client-only libraries). */
  | "client-only"
  /** A Client Component reference: fine to render from the server with serializable props. */
  | "client-reference"
  /** Only available on the server (next/headers, node:fs...). */
  | "server-only"
  /** A Server Action reference (from a "use server" module). */
  | "server-action";

export type FrameworkModuleRule =
  | { kind: "per-name"; classify: (importedName: string) => BindingClass }
  | { kind: "dynamic-import" }
  | { kind: "css-in-js" };

export type FrameworkAdapter = {
  name: string;
  /** Classifies a framework-owned bare specifier (e.g. "next/link"); undefined if not framework-owned. */
  classifyModule(specifier: string): FrameworkModuleRule | undefined;
  /** True if `process.env[name]` has the same value on the server and in the browser bundle. */
  isClientVisibleEnv(name: string): boolean;
  /** File basenames (without extension) that must remain Client Components (e.g. Next's error.tsx). */
  mustStayClientFiles: readonly string[];
  /**
   * Framework hooks that only read shared context (the same value for every caller), so a per-item
   * list island may call them (e.g. Next's usePathname).
   */
  sharedContextHooks: readonly string[];
};
