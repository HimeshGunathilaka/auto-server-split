import { SKIP_TITLES } from "../analysis/skip.js";
import type { BoundaryGraph } from "../graph.js";
import { formatBytes, isChange } from "../split.js";
import type { FileResult, RouteSaving, RunSummary } from "../types.js";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** One block per line (a diff line is never empty); a newline between blocks would add a blank line. */
function diffHtml(diff: string): string {
  return diff
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const cls =
        line.startsWith("+++") || line.startsWith("---") || line.startsWith("===")
          ? "meta"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : "";
      return `<span class="${cls ? `l ${cls}` : "l"}">${escape(line)}</span>`;
    })
    .join("");
}

function fileCard(f: FileResult): string {
  const change = isChange(f);
  const kind = change ? "change" : "skipped";
  const warned = (f.warnings?.length ?? 0) > 0;
  const status =
    f.status === "split"
      ? `<span class="pill split">split</span>`
      : f.status === "directive-removed"
        ? `<span class="pill split">"use client" removed</span>`
        : `<span class="pill skip">${escape(f.skipped?.code ?? f.status)}</span>`;
  const saving = f.bytesSaved
    ? `<span class="num">~${formatBytes(f.bytesSaved.conservative)}</span>`
    : f.measureError
      ? `<span class="muted">not measured</span>`
      : "";
  const body: string[] = [];
  if (f.skipped) {
    const loc = f.skipped.location ? ` (line ${f.skipped.location.line})` : "";
    body.push(
      `<p><strong>${escape(SKIP_TITLES[f.skipped.code])}</strong>${loc}: ${escape(f.skipped.message.split("\n")[0] ?? "")}</p>`,
    );
  }
  if (f.islands.length > 0) {
    body.push(
      `<h4>Islands</h4><ul>${f.islands
        .map((i) => {
          const what = i.effects
            ? "renders nothing, runs effects"
            : i.moved
              ? "helper moved whole"
              : `&lt;${escape(i.rootTag)}&gt;`;
          const props = i.props.length > 0 ? ` · props: ${escape(i.props.join(", "))}` : "";
          return `<li><code>${escape(i.name)}</code> ${what} · line ${i.line}${props}</li>`;
        })
        .join("")}</ul>`,
    );
  }
  if (change) {
    body.push(
      `<p class="muted">${Math.round(f.staticRatio * 100)}% of the JSX stays on the server${
        f.bytesSaved?.sharedWith?.length
          ? ` · the estimate assumes ${escape(f.bytesSaved.sharedWith.join(", "))} ${f.bytesSaved.sharedWith.length === 1 ? "changes" : "change"} too`
          : ""
      }${f.requires?.length ? ` · needs ${escape(f.requires.join(", "))}` : ""}</p>`,
    );
  }
  if (f.routes?.length) {
    body.push(
      `<h4>Routes</h4><ul>${f.routes
        .map(
          (r) =>
            `<li><code>${escape(r.route)}</code> ${r.load === "lazy" ? "(loaded later)" : ""}${
              r.bytesSaved !== undefined ? ` · ~${formatBytes(r.bytesSaved)}` : ""
            }</li>`,
        )
        .join("")}</ul>`,
    );
  }
  if (warned) {
    body.push(
      `<h4>Check before applying</h4><ul>${(f.warnings ?? [])
        .map(
          (w) =>
            `<li><span class="pill warn">${escape(w.code)}</span> ${w.location ? `line ${w.location.line}: ` : ""}${escape(w.message)}</li>`,
        )
        .join("")}</ul>`,
    );
  }
  if (f.diff) body.push(`<h4>Diff</h4><pre class="diff">${diffHtml(f.diff)}</pre>`);
  return `<details class="file" data-kind="${kind}" data-warned="${warned}" data-path="${escape(f.file.toLowerCase())}">
<summary>${status}<code class="path">${escape(f.file)}</code>${warned ? `<span class="pill warn">${f.warnings?.length} warning${f.warnings?.length === 1 ? "" : "s"}</span>` : ""}${saving}</summary>
<div class="body">${body.join("\n")}</div>
</details>`;
}

/**
 * A self-contained HTML report of a run (`--format html`): the totals, the routes, and every
 * `"use client"` file with its islands, warnings, routes and diff, filterable by status and path.
 * No external requests, so it works as a CI artifact.
 */
export function htmlReport(input: {
  files: readonly FileResult[];
  summary: RunSummary;
  routes?: readonly RouteSaving[];
  boundaries?: BoundaryGraph;
  project: string;
  applied: boolean;
  generatedAt: Date;
}): string {
  const { files, summary } = input;
  const changes = files.filter(isChange);
  const warnings = files.reduce((n, f) => n + (f.warnings?.length ?? 0), 0);
  const tile = (label: string, value: string, note = "") =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="muted">${note}</div>` : ""}</div>`;
  const tiles = [
    tile(
      input.applied ? "Changes applied" : "Changes available",
      String(changes.length),
      `${summary.splits} split${summary.splits === 1 ? "" : "s"}, ${summary.islands} island${summary.islands === 1 ? "" : "s"}${summary.directivesRemoved ? `, ${summary.directivesRemoved} directive${summary.directivesRemoved === 1 ? "" : "s"} removed` : ""}`,
    ),
    tile(
      "Estimated saving",
      summary.bytesSaved !== undefined ? formatBytes(summary.bytesSaved) : "–",
      "gzip client JavaScript, conservative",
    ),
    tile("Skipped", String(summary.skipped), `of ${summary.useClientFiles} "use client" files`),
    tile("Warnings", String(warnings), "risks to check before applying"),
    ...(summary.bestRoute
      ? [
          tile(
            "Best route",
            formatBytes(summary.bestRoute.initialSaved),
            `less up front on <code>${escape(summary.bestRoute.route)}</code>`,
          ),
        ]
      : []),
  ];
  const routes = input.routes?.length
    ? `<section><h2>Routes</h2><table><thead><tr><th>Route</th><th>Saved up front</th><th>Saved later</th><th>Route's JS before</th><th>Changes</th></tr></thead><tbody>${input.routes
        .map(
          (r) =>
            `<tr><td><code>${escape(r.route)}</code></td><td class="num">${r.initialSaved !== undefined ? formatBytes(r.initialSaved) : "–"}</td><td class="num">${r.lazySaved ? formatBytes(r.lazySaved) : "–"}</td><td class="num">${r.initialBytes !== undefined ? formatBytes(r.initialBytes) : "–"}</td><td>${r.files.map((f) => `<code>${escape(f)}</code>`).join(" ")}</td></tr>`,
        )
        .join("")}</tbody></table><p class="muted">${
        input.routes.some((r) => r.source === "next-analyze")
          ? "Sizes from the Next.js analyzer snapshot (the islands' own size is estimated)."
          : "Sizes estimated from esbuild bundles of the changed files."
      }</p></section>`
    : "";
  const boundaries = input.boundaries?.boundaries.length
    ? `<section><h2>Client boundaries</h2><table><thead><tr><th>"use client" file</th><th>Rendered by</th><th>Client modules</th><th>Packages</th></tr></thead><tbody>${input.boundaries.boundaries
        .map(
          (b) =>
            `<tr><td><code>${escape(b.file)}</code>${b.barrel ? ` <span class="pill warn">barrel</span>` : ""}</td><td>${b.renderedBy.map((r) => `<code>${escape(r.file)}</code>`).join(" ") || "–"}</td><td class="num">${b.modules.length}</td><td>${b.packages.map(escape).join(", ") || "–"}</td></tr>`,
        )
        .join("")}</tbody></table></section>`
    : "";
  const ordered = [...files].sort(
    (a, b) =>
      Number(isChange(b)) - Number(isChange(a)) ||
      (b.bytesSaved?.conservative ?? 0) - (a.bytesSaved?.conservative ?? 0) ||
      a.file.localeCompare(b.file),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>auto-server-split report</title>
<style>
:root { --bg: #ffffff; --fg: #1b1f24; --muted: #5b636d; --line: #d9dee3; --card: #f6f8fa; --accent: #1a7f37; --warn: #9a6700; --bad: #cf222e; --add: #dafbe1; --del: #ffebe9; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #30363d; --card: #161b22; --accent: #3fb950; --warn: #d29922; --bad: #f85149; --add: #12261e; --del: #2d1316; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 12px; } h4 { margin: 16px 0 6px; font-size: 14px; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.muted { color: var(--muted); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-top: 20px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.tile .label { color: var(--muted); font-size: 13px; } .tile .value { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 13px; color: var(--muted); font-weight: 600; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.toolbar button { background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 12px; cursor: pointer; font: inherit; font-size: 13px; }
.toolbar button[aria-pressed="true"] { border-color: var(--fg); font-weight: 600; }
.toolbar input { flex: 1 1 200px; min-width: 0; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 13px; }
details.file { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; background: var(--card); }
details.file > summary { cursor: pointer; padding: 10px 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
details.file > summary .path { flex: 1 1 auto; overflow-wrap: anywhere; }
.body { padding: 0 14px 12px; border-top: 1px solid var(--line); }
.pill { display: inline-block; font-size: 12px; border-radius: 999px; padding: 1px 8px; border: 1px solid currentColor; }
.pill.split { color: var(--accent); } .pill.skip { color: var(--muted); } .pill.warn { color: var(--warn); }
pre.diff { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow-x: auto; }
pre.diff .l { display: block; } pre.diff .add { background: var(--add); } pre.diff .del { background: var(--del); } pre.diff .hunk { color: var(--muted); } pre.diff .meta { font-weight: 600; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
<h1>auto-server-split report</h1>
<div class="muted"><code>${escape(input.project)}</code> · ${escape(input.generatedAt.toISOString().replace("T", " ").slice(0, 16))} UTC · ${summary.filesScanned} file${summary.filesScanned === 1 ? "" : "s"} scanned${input.applied ? " · changes applied" : " · dry run"}</div>
<div class="tiles">${tiles.join("")}</div>
${routes}
<section>
<h2>Files</h2>
<div class="toolbar" role="group" aria-label="Filter files">
<button type="button" data-filter="all" aria-pressed="true">All (${files.length})</button>
<button type="button" data-filter="change" aria-pressed="false">Changes (${changes.length})</button>
<button type="button" data-filter="skipped" aria-pressed="false">Skipped (${files.length - changes.length})</button>
<button type="button" data-filter="warned" aria-pressed="false">With warnings</button>
<input type="search" placeholder="Filter by path" aria-label="Filter by path">
</div>
${ordered.map(fileCard).join("\n")}
</section>
${boundaries}
</main>
<script>
(() => {
  const cards = [...document.querySelectorAll("details.file")];
  const buttons = [...document.querySelectorAll("[data-filter]")];
  const search = document.querySelector('input[type="search"]');
  let filter = "all";
  const apply = () => {
    const q = (search.value || "").toLowerCase();
    for (const card of cards) {
      const kind = filter === "all" || (filter === "warned" ? card.dataset.warned === "true" : card.dataset.kind === filter);
      card.hidden = !kind || (q !== "" && !card.dataset.path.includes(q));
    }
  };
  for (const button of buttons)
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      for (const b of buttons) b.setAttribute("aria-pressed", String(b === button));
      apply();
    });
  search.addEventListener("input", apply);
})();
</script>
</body>
</html>
`;
}
