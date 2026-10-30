// Renders the README diagrams to docs/images/<name>-{light,dark}.png (2x), from the SVG built below.
// Usage: node scripts/diagrams.mjs   (needs Playwright's Chromium: pnpm exec playwright install chromium)
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const out = path.resolve(import.meta.dirname, "../docs/images");

const THEMES = {
  light: {
    bg: "#ffffff",
    text: "#1f2328",
    muted: "#59636e",
    line: "#d0d7de",
    edge: "#818b98",
    card: "#f6f8fa",
    blue: { fill: "#ddf4ff", stroke: "#54aeff", ink: "#0969da" },
    green: { fill: "#dafbe1", stroke: "#4ac26b", ink: "#1a7f37" },
    amber: { fill: "#fff8c5", stroke: "#d4a72c", ink: "#9a6700" },
    red: { fill: "#ffebe9", stroke: "#ff8182", ink: "#cf222e" },
    gray: { fill: "#f6f8fa", stroke: "#afb8c1", ink: "#59636e" },
  },
  dark: {
    bg: "#0d1117",
    text: "#e6edf3",
    muted: "#9198a1",
    line: "#3d444d",
    edge: "#6e7681",
    card: "#151b23",
    blue: { fill: "#0c2d6b", stroke: "#1f6feb", ink: "#58a6ff" },
    green: { fill: "#033a16", stroke: "#238636", ink: "#3fb950" },
    amber: { fill: "#3b2300", stroke: "#9e6a03", ink: "#d29922" },
    red: { fill: "#4b1113", stroke: "#da3633", ink: "#f85149" },
    gray: { fill: "#151b23", stroke: "#3d444d", ink: "#9198a1" },
  },
};

const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A rounded box: a title, sublabel lines and an optional chip, centred. */
function box(t, { x, y, w, h, tone, title, mono = false, sub = [], chip, step }) {
  const c = t[tone];
  const cx = x + w / 2;
  const lines = [];
  // Title, sublabels and chip as one block, centred vertically.
  const height = 14 + sub.length * 17 + (chip ? 30 : 0);
  const top = y + (h - height) / 2 + 13;
  lines.push(
    `<text x="${cx}" y="${top}" text-anchor="middle" font-family="${mono ? MONO : SANS}" font-size="16" font-weight="600" fill="${t.text}">${esc(title)}</text>`,
  );
  sub.forEach((s, i) =>
    lines.push(
      `<text x="${cx}" y="${top + 21 + i * 17}" text-anchor="middle" font-family="${s.startsWith("-") || s.startsWith("npx") ? MONO : SANS}" font-size="${s.startsWith("-") || s.startsWith("npx") ? 11.5 : 12.5}" fill="${t.muted}">${esc(s)}</text>`,
    ),
  );
  if (chip) {
    const cw = chip.length * 6.6 + 20;
    const cy = top + 21 + (sub.length - 1) * 17 + 13;
    lines.push(
      `<rect x="${cx - cw / 2}" y="${cy}" width="${cw}" height="19" rx="9.5" fill="${t.bg}" stroke="${c.stroke}"/>`,
      `<text x="${cx}" y="${cy + 13.5}" text-anchor="middle" font-family="${SANS}" font-size="11.5" fill="${c.ink}">${esc(chip)}</text>`,
    );
  }
  if (step !== undefined)
    lines.push(
      `<circle cx="${x + 2}" cy="${y + 2}" r="12" fill="${c.ink}"/>`,
      `<text x="${x + 2}" y="${y + 6.5}" text-anchor="middle" font-family="${SANS}" font-size="12.5" font-weight="700" fill="${t.bg}">${step}</text>`,
    );
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>\n${lines.join("\n")}`;
}

/** An arrow along points, with an optional label on a background at `at`. */
function arrow(t, points, { label, at, dashed = false, color } = {}) {
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const stroke = color ?? t.edge;
  let svg = `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8"${dashed ? ' stroke-dasharray="6 5"' : ""} marker-end="url(#head-${stroke.slice(1)})"/>`;
  if (label) {
    const [lx, ly] = at;
    const lw = label.length * 6.9 + 14;
    svg += `\n<rect x="${lx - lw / 2}" y="${ly - 11}" width="${lw}" height="20" rx="4" fill="${t.bg}"/>`;
    svg += `\n<text x="${lx}" y="${ly + 3.5}" text-anchor="middle" font-family="${SANS}" font-size="12.5" fill="${t.muted}">${esc(label)}</text>`;
  }
  return svg;
}

function note(t, { x, y, w, h, tone, title, items }) {
  const c = t[tone];
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${t.card}" stroke="${t.line}"/>`,
    `<circle cx="${x + 20}" cy="${y + 24}" r="5" fill="${c.ink}"/>`,
    `<text x="${x + 33}" y="${y + 29}" font-family="${SANS}" font-size="14" font-weight="600" fill="${t.text}">${esc(title)}</text>`,
    ...items.map(
      (s, i) =>
        `<text x="${x + 20}" y="${y + 54 + i * 21}" font-family="${SANS}" font-size="13" fill="${t.muted}">${esc(s)}</text>`,
    ),
  ].join("\n");
}

function svg(t, w, h, title, body) {
  const heads = [...new Set([t.edge, t.blue.ink, t.green.ink])]
    .map(
      (c) =>
        `<marker id="head-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs>${heads}</defs>
<rect width="${w}" height="${h}" rx="14" fill="${t.bg}"/>
<text x="40" y="48" font-family="${SANS}" font-size="20" font-weight="700" fill="${t.text}">${esc(title)}</text>
${body}
</svg>`;
}

const DIAGRAMS = {
  "what-it-does": (t) =>
    svg(
      t,
      1200,
      560,
      "What auto-server-split does",
      [
        box(t, {
          x: 40,
          y: 170,
          w: 220,
          h: 104,
          tone: "red",
          title: "PostCard.tsx",
          mono: true,
          sub: ['"use client" component'],
          chip: "all of it ships",
        }),
        box(t, {
          x: 340,
          y: 170,
          w: 220,
          h: 104,
          tone: "blue",
          title: "auto-server-split",
          sub: ["analyse · split · self-check"],
          chip: "typechecked in memory",
        }),
        box(t, {
          x: 660,
          y: 88,
          w: 240,
          h: 104,
          tone: "green",
          title: "PostCard.tsx",
          mono: true,
          sub: ["Server Component"],
          chip: "date-fns, marked stay here",
        }),
        box(t, {
          x: 660,
          y: 252,
          w: 240,
          h: 104,
          tone: "amber",
          title: "PostCard.client.tsx",
          mono: true,
          sub: ["client island: <button>"],
          chip: "generated",
        }),
        box(t, {
          x: 980,
          y: 170,
          w: 180,
          h: 104,
          tone: "gray",
          title: "Browser",
          sub: ["HTML + a small island"],
        }),
        arrow(
          t,
          [
            [260, 222],
            [338, 222],
          ],
          { label: "scan", at: [299, 205] },
        ),
        arrow(
          t,
          [
            [560, 222],
            [610, 222],
            [610, 140],
            [658, 140],
          ],
          { label: "static parts", at: [610, 120], color: t.green.ink },
        ),
        arrow(
          t,
          [
            [610, 222],
            [610, 304],
            [658, 304],
          ],
          { label: "interactive parts", at: [584, 330] },
        ),
        arrow(
          t,
          [
            [900, 140],
            [940, 140],
            [940, 205],
            [978, 205],
          ],
          { label: "HTML", at: [940, 120], color: t.green.ink },
        ),
        arrow(
          t,
          [
            [900, 304],
            [940, 304],
            [940, 240],
            [978, 240],
          ],
          { label: "small JS", at: [940, 330], dashed: true },
        ),
        note(t, {
          x: 40,
          y: 396,
          w: 360,
          h: 124,
          tone: "red",
          title: "Before",
          items: [
            "The whole component ships to the browser,",
            "and date-fns and marked ship with it.",
          ],
        }),
        note(t, {
          x: 420,
          y: 396,
          w: 360,
          h: 124,
          tone: "green",
          title: "After",
          items: [
            "Static markup renders on the server; only",
            "the button ships. The e2e route loads",
            "18.5 KB gzip less JavaScript.",
          ],
        }),
        note(t, {
          x: 800,
          y: 396,
          w: 360,
          h: 124,
          tone: "blue",
          title: "Safe by default",
          items: [
            "Same HTML, same behaviour. A file it can't",
            "prove safe is left alone, with the reason.",
          ],
        }),
      ].join("\n"),
    ),

  workflow: (t) => {
    const w = 168;
    const y = 128;
    const xs = [40, 233, 426, 619, 812, 1005].map((x) => x - 4);
    const steps = [
      { tone: "blue", title: "Preview", sub: ["npx auto-server-split"], chip: "nothing written" },
      { tone: "gray", title: "Review", sub: ["diffs, savings, skips"] },
      { tone: "blue", title: "Apply", sub: ["--write or", "--interactive"] },
      { tone: "gray", title: "Verify", sub: ["build, tests,", "click through"] },
      { tone: "gray", title: "Commit", sub: ["one reviewable diff"] },
      {
        tone: "green",
        title: "CI check",
        sub: ["--check or the", "GitHub Action"],
        chip: "flags new splits",
      },
    ];
    const band = (x1, x2, label, tone) =>
      `<rect x="${x1}" y="80" width="${x2 - x1}" height="26" rx="6" fill="${t[tone].fill}"/>` +
      `<text x="${(x1 + x2) / 2}" y="98" text-anchor="middle" font-family="${SANS}" font-size="12.5" font-weight="600" fill="${t[tone].ink}">${label}</text>`;
    return svg(
      t,
      1200,
      440,
      "Using auto-server-split",
      [
        band(xs[0], xs[1] + w, "Preview", "blue"),
        band(xs[2], xs[3] + w, "Apply", "amber"),
        band(xs[4], xs[5] + w, "Keep it split", "green"),
        ...steps.map((s, i) => box(t, { x: xs[i], y, w, h: 112, step: i + 1, ...s })),
        ...steps.slice(1).map((_, i) =>
          arrow(t, [
            [xs[i] + w, y + 56],
            [xs[i + 1] - 2, y + 56],
          ]),
        ),
        box(t, {
          x: xs[1],
          y: 300,
          w,
          h: 96,
          tone: "amber",
          title: "Explain a skip",
          sub: ["--explain <file>"],
          chip: "says how to fix it",
        }),
        arrow(
          t,
          [
            [xs[1] + w / 2, y + 112],
            [xs[1] + w / 2, 298],
          ],
          { label: "why skipped?", at: [xs[1] + w / 2, 270], dashed: true },
        ),
        `<text x="${xs[3]}" y="342" font-family="${SANS}" font-size="13" fill="${t.muted}">--write needs a clean git state, so the whole change is one diff you can review</text>`,
        `<text x="${xs[3]}" y="362" font-family="${SANS}" font-size="13" fill="${t.muted}">or undo. --interactive lets you accept, reject or rename each split.</text>`,
      ].join("\n"),
    );
  },
};

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const [name, draw] of Object.entries(DIAGRAMS)) {
  for (const [theme, t] of Object.entries(THEMES)) {
    const source = draw(t);
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${source}</body></html>`,
    );
    const file = path.join(out, `${name}-${theme}.png`);
    await page.locator("svg").screenshot({ path: file, omitBackground: true });
    console.log(path.relative(process.cwd(), file));
  }
}
await browser.close();
