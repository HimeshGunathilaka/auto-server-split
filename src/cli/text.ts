import pc from "picocolors";
import { SKIP_TITLES } from "../analysis/skip.js";
import type { Explanation } from "../explain.js";
import type { BoundaryGraph } from "../graph.js";
import { formatBytes } from "../split.js";
import type { FileResult, IslandInfo } from "../types.js";

export function colorDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("==="))
        return pc.bold(line);
      if (line.startsWith("+")) return pc.green(line);
      if (line.startsWith("-")) return pc.red(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      return line;
    })
    .join("\n");
}

function savedText(file: FileResult, assumes = ""): string {
  return file.bytesSaved
    ? ` · ~${formatBytes(file.bytesSaved.conservative)} gzip saved (estimated${assumes})`
    : file.measureError
      ? ` · ${pc.yellow("saving not measured")} (${file.measureError})`
      : "";
}

/** The changes a later pass found this one after: they have to be applied with it. */
function needsText(file: FileResult): string {
  const needs = file.requires ?? [];
  if (needs.length === 0) return "";
  const list = needs.length <= 2 ? needs.join(" and ") : `${needs.length} other changes`;
  return ` · ${pc.dim(`needs ${list} changed too`)}`;
}

function describeWarnings(file: FileResult): string {
  return (file.warnings ?? [])
    .map((w) => {
      const loc = w.location ? `:${w.location.line}:${w.location.column}` : "";
      return `\n    ${pc.yellow("⚠")} ${file.file}${loc} ${pc.dim(`[${w.code}]`)} ${w.message}`;
    })
    .join("");
}

/** `/ ~9.7 KB, /blog/[slug] ~1.2 KB (later)` */
export function routesText(file: FileResult, max = 3): string {
  const routes = file.routes ?? [];
  if (routes.length === 0) return "";
  const shown = routes.slice(0, max).map((r) => {
    const saved = r.bytesSaved !== undefined ? ` ~${formatBytes(r.bytesSaved)}` : "";
    return `${r.route}${saved}${r.load === "lazy" ? " (loaded later)" : ""}`;
  });
  const more = routes.length > max ? `, and ${routes.length - max} more` : "";
  return `${shown.join(", ")}${more}`;
}

export function islandText(i: IslandInfo): string {
  if (i.effects) return `${i.name} (renders nothing; runs the effects no element uses)`;
  return `${i.name} <${i.rootTag}>${i.props.length ? ` (props: ${i.props.join(", ")})` : ""}`;
}

export function describeChange(file: FileResult): string {
  return describeChangeLine(file) + describeWarnings(file);
}

function describeChangeLine(file: FileResult): string {
  const routes = file.routes?.length ? `\n    ${pc.dim(`routes: ${routesText(file)}`)}` : "";
  if (file.status === "directive-removed")
    return `${pc.green('✔ removed "use client"')} ${pc.bold(file.file)} · no client-only code${savedText(file)}${needsText(file)}${routes}`;
  const shared = file.bytesSaved?.sharedWith ?? [];
  const assumes =
    shared.length === 0
      ? ""
      : shared.length <= 2
        ? `; assumes ${shared.join(" and ")} ${shared.length === 1 ? "is" : "are"} changed too`
        : `; assumes ${shared.length} other files are changed too`;
  const saved = savedText(file, assumes);
  return `${pc.green("✔ split")} ${pc.bold(file.file)} · ${file.islands.length} island${file.islands.length === 1 ? "" : "s"} · ${Math.round(file.staticRatio * 100)}% static${saved}${needsText(file)}\n    ${file.islands.map(islandText).join("\n    ")}${routes}`;
}

export function describeSkip(file: FileResult, verbose: boolean): string {
  const s = file.skipped;
  if (!s) return "";
  const loc = s.location ? `:${s.location.line}:${s.location.column}` : "";
  let message = s.message;
  if (s.code === "internal-error" && !verbose) message = message.split("\n")[0] ?? message;
  const color = s.code === "internal-error" || s.code === "self-check-failed" ? pc.red : pc.yellow;
  return `${color("– skipped")} ${file.file}${loc} ${pc.dim(`[${s.code}]`)} ${message}`;
}

const FATE_TEXT = {
  island: "moves into the island",
  "leaves-client": "leaves the client bundle",
  "still-shipped": "stays on the server, but still ships: other client code imports it",
  "server-only": "server-only",
} as const;

/** `--explain`: the explanation as text. */
export function explanationLines(e: Explanation): string[] {
  const lines: string[] = [];
  const kind = {
    "client-boundary": '"use client" boundary',
    client: "client code",
    server: "server code: only Server Components import it",
    "outside-project": "outside the project: the module graph doesn't cover it",
  }[e.kind];
  const shown =
    e.unimported && e.kind === "server"
      ? "server code: nothing imports it (a route file, or unused)"
      : kind;
  lines.push(`${pc.bold(e.file)}  ${pc.dim(shown)}`);
  if (e.clientChain) {
    lines.push(
      `  ${pc.dim("why it's client code:")} ${e.clientChain[0]} ("use client") → ${e.clientChain.slice(1).join(" → ")}`,
    );
  }
  if (e.renderedBy) {
    const by = e.renderedBy.map((r) => `${r.file}:${r.line}`).join(", ");
    const what = e.kind === "client-boundary" ? "rendered by" : "the boundary is rendered by";
    lines.push(
      `  ${pc.dim(`${what}:`)} ${by || (e.unimported ? "nothing (not imported: a route file, or unused)" : "no Server Component (only client code imports it)")}`,
    );
  }
  if (e.serverUse) {
    const { safe, reason, exports } = e.serverUse;
    lines.push(
      `  ${pc.dim("in a Server Component:")} ${safe ? pc.green("safe to import") : `${pc.yellow("client-only")} (${reason ?? "uses client APIs"})`}`,
    );
    if (!safe) {
      for (const x of exports)
        lines.push(
          `    ${x.safe ? pc.green("✔") : pc.yellow("✗")} ${x.name}${x.safe ? "" : pc.dim(` ${x.reason ?? ""}`)}`,
        );
    }
  }
  const r = e.result;
  if (r) {
    if (r.status === "split" || r.status === "directive-removed") {
      lines.push(`  ${describeChange(r).split("\n").join("\n  ")}`);
    } else if (r.skipped) {
      lines.push(`  ${describeSkip(r, false)}`);
      lines.push(`  ${pc.dim(`(${SKIP_TITLES[r.skipped.code]})`)}`);
    }
  }
  for (const c of e.components ?? []) {
    const multiple = (e.components?.length ?? 0) > 1;
    if (c.anchors.length > 0) {
      lines.push(`  ${pc.dim(`${multiple ? `${c.name}: ` : ""}elements that need the client:`)}`);
      for (const a of c.anchors)
        lines.push(`    ${a.element} (line ${a.line}): ${a.reasons.join(", ")}`);
    }
    if (c.steps.length > 0) {
      lines.push(`  ${pc.dim(`${multiple ? `${c.name}: ` : ""}how the islands were formed:`)}`);
      for (const step of c.steps) lines.push(`    ${step}`);
    }
  }
  if (e.imports?.length) {
    lines.push(`  ${pc.dim("imports:")}`);
    for (const fate of ["leaves-client", "island", "still-shipped", "server-only"] as const) {
      const modules = e.imports.filter((i) => i.fate === fate).map((i) => i.module);
      if (modules.length > 0) lines.push(`    ${modules.join(", ")}: ${FATE_TEXT[fate]}`);
    }
  }
  if (e.note) lines.push(`  ${pc.dim(e.note)}`);
  if (e.suggestion) lines.push(`  ${pc.cyan("suggestion:")} ${e.suggestion}`);
  return lines;
}

/** `--graph`: the client boundaries as text. */
export function graphLines(graph: BoundaryGraph): string[] {
  const count = graph.boundaries.length;
  const lines = [
    pc.bold(`Client boundaries (${count} "use client" file${count === 1 ? "" : "s"})`),
    "",
  ];
  for (const b of graph.boundaries) {
    lines.push(`${pc.bold(b.file)}${b.barrel ? pc.yellow("  barrel") : ""}`);
    if (b.renderedBy.length > 0)
      lines.push(`  rendered by ${b.renderedBy.map((r) => `${r.file}:${r.line}`).join(", ")}`);
    if (b.clientImporters.length > 0)
      lines.push(`  ${pc.dim(`also imported by client code: ${b.clientImporters.join(", ")}`)}`);
    if (b.renderedBy.length === 0 && b.clientImporters.length === 0)
      lines.push(`  ${pc.dim("not imported (a route file, or unused)")}`);
    const pulls = [
      b.modules.length > 0
        ? `${b.modules.length} module${b.modules.length === 1 ? "" : "s"} (${b.modules.slice(0, 4).join(", ")}${b.modules.length > 4 ? ", ..." : ""})`
        : "",
      b.packages.length > 0 ? `packages: ${b.packages.join(", ")}` : "",
    ].filter(Boolean);
    if (pulls.length > 0) lines.push(`  pulls in ${pulls.join(" · ")}`);
    if (b.barrel?.serverSafe.length)
      lines.push(
        `  ${pc.yellow('re-exports modules that don\'t need "use client":')} ${b.barrel.serverSafe.join(", ")} (import them directly, or move the directive into the files that need it)`,
      );
  }
  return lines;
}
