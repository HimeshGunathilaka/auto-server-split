// TypeScript resolves this module; esbuild can't, so the saving can't be measured.
declare module "virtual-fmt" {
  export function fmt(s: string): string;
}
