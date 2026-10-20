/**
 * Packages whose exports only work in the browser or rely on client React APIs (state, effects,
 * context). Anything imported from these is client-only. Entries ending in `/*` match a scope.
 */
export const BUILTIN_CLIENT_ONLY_PACKAGES = [
  "framer-motion",
  "motion",
  "react-hook-form",
  "@hookform/*",
  "swiper",
  "recharts",
  "chart.js",
  "react-chartjs-2",
  "@tanstack/react-query",
  "@tanstack/react-table",
  "@tanstack/react-virtual",
  "@tanstack/react-form",
  "zustand",
  "jotai",
  "valtio",
  "react-redux",
  "@reduxjs/toolkit",
  "mobx-react",
  "mobx-react-lite",
  "swr",
  "@apollo/client",
  "urql",
  "react-hot-toast",
  "react-toastify",
  "sonner",
  "@radix-ui/*",
  "@headlessui/react",
  "@floating-ui/react",
  "@floating-ui/react-dom",
  "@ariakit/react",
  "react-aria",
  "react-aria-components",
  "react-select",
  "react-dnd",
  "react-dnd-html5-backend",
  "@dnd-kit/*",
  "react-beautiful-dnd",
  "@hello-pangea/dnd",
  "react-spring",
  "@react-spring/*",
  "@use-gesture/react",
  "embla-carousel-react",
  "keen-slider",
  "react-slick",
  "gsap",
  "@gsap/react",
  "lottie-react",
  "@lottiefiles/react-lottie-player",
  "react-confetti",
  "react-countup",
  "@react-three/fiber",
  "@react-three/drei",
  "three",
  "react-leaflet",
  "leaflet",
  "mapbox-gl",
  "react-map-gl",
  "maplibre-gl",
  "react-day-picker",
  "react-datepicker",
  "react-colorful",
  "react-color",
  "cmdk",
  "vaul",
  "react-dropzone",
  "react-player",
  "react-quill",
  "@tiptap/react",
  "slate-react",
  "@lexical/react",
  "react-intersection-observer",
  "react-use",
  "usehooks-ts",
  "@uidotdev/usehooks",
  "react-hotkeys-hook",
  "react-modal",
  "react-transition-group",
  "react-window",
  "react-virtualized",
  "react-virtuoso",
  "next-themes",
  "@mantine/*",
  "@chakra-ui/*",
  "antd",
  "@mui/*",
  "react-bootstrap",
  "@nextui-org/*",
  "@heroui/*",
  "react-i18next",
  "@clerk/nextjs",
  "next-auth/react",
  "@supabase/auth-helpers-react",
  "posthog-js",
  "react-ga4",
];

/** Runtime CSS-in-JS libraries. A file that uses one is always skipped. */
export const CSS_IN_JS_PACKAGES = [
  "styled-components",
  "@emotion/react",
  "@emotion/styled",
  "@emotion/css",
  "@emotion/core",
  "@stitches/react",
  "goober",
  "styled-jsx",
  "styled-jsx/css",
  "theme-ui",
  "jss",
  "react-jss",
  "@linaria/react",
  "styled-system",
];

/**
 * React-dependent packages verified to render correctly as Server Components (pure function
 * components, no context, state or effects). Everything else that depends on React and has no
 * "use client" entry is treated as client-only.
 */
export const BUILTIN_SERVER_SAFE_PACKAGES = ["@heroicons/react", "@radix-ui/react-icons"];

export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** Matches a specifier against a package list (exact name, subpath, or `@scope/*`). */
export function matchesPackageList(specifier: string, list: readonly string[]): boolean {
  const name = packageNameOf(specifier);
  return list.some((entry) => {
    if (entry.endsWith("/*")) return name.startsWith(entry.slice(0, -1));
    return entry === name || entry === specifier || specifier.startsWith(`${entry}/`);
  });
}
