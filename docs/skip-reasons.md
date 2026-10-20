# Skip reasons

When `auto-server-split` isn't sure a split is safe, it leaves the file alone and reports a stable
`SkipCode`, a one-sentence message and (when there is one) a source location. Skipping is the
designed behaviour, not a failure: a skipped file is exactly as it was.

Each section shows a minimal example and how to change the code so it can be split.

---

## `imported-by-client`

Another client module imports the file, directly or through a barrel. Once the directive is
removed, that module would pull a Server Component into the client bundle, which React doesn't allow.

```tsx
// components/Sidebar.tsx
"use client";
import PostCard from "./PostCard"; // ← PostCard is skipped: imported by components/Sidebar.tsx (client)
```

The same code is used when an importer can't be verified: it's outside the TypeScript project
(for example an `.mdx` file, or a `.js` file without `allowJs`), or (in the ESLint rule without typed
linting) it couldn't be loaded.

**To fix:** render `PostCard` from a Server Component instead, or pass it to the client component as
`children` / a JSX prop (`<Sidebar card={<PostCard post={post} />} />`). If the importer is client only
because of a barrel (`components/index.ts`), import the file directly.

## `exports-non-components`

Removing `"use client"` changes every export of the file. The tool only does that when the file
exports components and types. Hooks, utilities, constants, classes, enums and re-exports are refused.

```tsx
"use client";
export function useLike() {
  /* ... */
} // ← exports useLike, which is not a component
export default function PostCard() {
  /* ... */
}
```

**To fix:** move hooks and helpers into their own module (`hooks/useLike.ts`).

## `state-spans-component`

The client state is read so widely that the smallest island containing every reader is the whole
returned element, or it's read by non-JSX code in the return expression.

```tsx
const [open, setOpen] = useState(false);
return (
  <div className={open ? "open" : ""}>
    {" "}
    {/* the root reads `open`… */}
    <button onClick={() => setOpen(!open)} /> {/* …and so does a deep child */}
  </div>
);
```

**To fix:** keep the state next to the elements that use it (for example, move the class toggle onto
the element the button controls), or extract the interactive region into its own component.

## `context-provider`

The file creates a Context (`createContext`) or renders `<X.Provider>` / `<X value>`. Providers
must be Client Components and their whole subtree is affected.

**To fix:** move the context and provider into a small `providers.tsx` client file and render it
from a Server Component.

## `css-in-js-runtime`

The file uses styled-components, Emotion, Stitches, goober, styled-jsx (`<style jsx>`) or another
runtime CSS-in-JS library. These need client rendering, so they are always skipped.

**To fix:** use CSS Modules, Tailwind or another zero-runtime styling approach.

## `non-serializable-prop`

A value that would cross the boundary as an island prop isn't serializable (functions other than
Server Actions, class instances, symbols, `any`/`unknown`, ...). The message names the prop and its type.

```tsx
export default function ItemRow({
  item,
  onSelect,
}: {
  item: Item;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      …<button onClick={() => onSelect(item.id)}>Select</button>
    </li>
  );
  // ← `onSelect` (type `(id: string) => void`) would be passed to a Client Component, but it is a function
}
```

A function-typed prop is allowed when every importer passes a Server Action for it. Mongoose
documents and values containing `ObjectId`s can cross the boundary with `mongoose.autoSerialize: true`,
as long as the island only reads individual fields (not the whole object).

**To fix:** pass data instead of behaviour (an id or URL), make the function a Server Action
(`"use server"`), or keep the component fully client-side.

## `untyped-boundary`

The file is `.js`/`.jsx`, so types are inferred. Only props whose values are literals or whose
inferred types are primitive can be proven serializable.

**To fix:** convert the file to TypeScript, or pass primitives (`post.id`) instead of objects.

## `spread-props`

A spread (`{...rest}`) would cross the boundary and its type can't be proven serializable (it may
carry event handlers or refs).

**To fix:** destructure the specific props the interactive element needs.

## `conditional-hooks-or-returns`

A hook is called conditionally, inside JSX, or after an early return; or the component returns
early based on client-only state. The server couldn't decide what to render.

```tsx
if (!user) return <p>Not signed in</p>;
const [open, setOpen] = useState(false); // ← calls useState() after an early return
```

**To fix:** call hooks unconditionally at the top of the component (this is also a Rules of Hooks
violation), and base early returns on props.

## `class-component`

The file contains a class component (`extends React.Component`).

**To fix:** convert it to a function component.

## `dynamic-import`

The file uses `next/dynamic`, `React.lazy` or `import()`, or another module loads it with `import()`.

**To fix:** this version doesn't split these. Import the component statically if you can.

## `render-prop`

A render function crosses the boundary (`renderItem={(x) => <li />}`), a function is used as a child,
or an interactive element sits inside a callback other than `.map()`.

**To fix:** pass data and let the child render it, or use `children`.

## `hoc`

The component is wrapped in `memo`, `forwardRef` or another higher-order function.

**To fix:** in React 19, `ref` is a regular prop, so `forwardRef` is usually unnecessary; `memo` has no
effect on Server Components. Remove the wrapper if you can.

## `server-env-difference`

The component reads `process.env.X` where `X` doesn't start with `NEXT_PUBLIC_` (or reads `process`
dynamically). In a client bundle that value is `undefined`; on the server it's defined, so moving
the code to the server would change what renders.

**To fix:** if the value should be public, rename it `NEXT_PUBLIC_X`; otherwise read it in a Server
Component on purpose and pass what the client needs as a prop.

## `no-islands`

The file has no client-only code at all. The `"use client"` directive may simply be unnecessary.
The tool never removes it automatically; check that nothing imports the file expecting a client
component, then remove it yourself.

## `fully-interactive`

The interactive part _is_ the whole returned element (for example the component returns a single
`<button onClick>`), so nothing would stay on the server. In a file with several components, a
non-exported helper like this is moved whole into the island file instead; the code is used only
when an exported component (or every component) is entirely interactive.

**To fix:** nothing to do: this component belongs on the client.

## `below-threshold`

The split would save less than `minBytesSaved` (gzip, conservative estimate; default 2048) or keep
less than `minStaticRatio` of the JSX on the server (default 0.3).

**To fix:** lower the thresholds in `auto-split.config.*` if small splits are worth it to you.

## `output-exists` / `would-create-route`

`X.client.tsx` already exists (the tool never merges into an existing file), or the generated file could
be picked up as a Next.js route (anything under `pages/`, an app-router `page`/`route` file for one
of the configured `pageExtensions`, or a `next.config` whose `pageExtensions` can't be read statically).

**To fix:** rename or remove the existing file, or set `clientFileSuffix` / `islandsDir`.

## `unsupported-pattern`

Valid code that this version can't split safely yet. The message says which pattern, for example:

- statements in the component body other than `const` declarations, function declarations, hook
  calls and early returns;
- a `useEffect` (or other client-only code) that uses no island's state, so there is no island to
  carry it (effects that sync an island's state move with that island);
- an exported component, in a file with several components, that is entirely interactive (the
  message says which component; the whole file is skipped);
- Next.js `error.tsx` / `global-error.tsx`, which must stay Client Components;
- module-level `let`/`var`, side effects, or a side-effect import of a JS module;
- the component used as a value (not as `<X />`) by an importer;
- a prop type that can't be named in the generated file, or an interactive-mode rename that isn't a
  valid, unused component name.

## `self-check-failed`

The generated code failed the self-check (it didn't parse, typechecking found new errors, client
code remained in the server file, a prop wasn't serializable, or the island imported a server-only
module). Nothing is written. Please report it with the message.

## `parse-error` / `internal-error`

The file couldn't be parsed, or the tool hit a bug. The run continues with the other files; run with
`--verbose` for a stack trace and please report it.
