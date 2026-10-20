// End-to-end check. For every app under e2e/apps:
//   1. copy it twice into e2e/.tmp (inside the repo, so next/react resolve from the root node_modules)
//   2. `next build` the untouched copy ("before")
//   3. run the codemod with --write on the other copy, check the expected splits/skips, `next build` it ("after")
//   4. `next start` both, fetch every route, normalise the HTML and require it to be identical
//   5. drive both with Playwright through the same interactions and require identical DOM after every step
//      (and that each click actually changed something, so islands are proven interactive)
//   6. print the per-route client JavaScript actually downloaded, before vs after
//
// Usage: pnpm build && pnpm test:e2e [appName...]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { gzipSync } from "node:zlib";
import { createTwoFilesPatch } from "diff";
import { chromium } from "@playwright/test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appsDir = path.join(repoRoot, "e2e/apps");
const tmpDir = path.join(repoRoot, "e2e/.tmp");
const nextBin = path.join(repoRoot, "node_modules/next/dist/bin/next");
const cli = path.join(repoRoot, "dist/cli.js");

const only = process.argv.slice(2);
const apps = readdirSync(appsDir).filter(
  (d) => !d.startsWith(".") && (only.length === 0 || only.includes(d)),
);
if (apps.length === 0) {
  console.log("e2e: no apps");
  process.exit(0);
}
if (!existsSync(cli)) {
  console.error("e2e: dist/cli.js is missing; run `pnpm build` first");
  process.exit(1);
}

const env = {
  ...process.env,
  AUTO_SPLIT_REPO_ROOT: repoRoot,
  NEXT_TELEMETRY_DISABLED: "1",
  TZ: "UTC",
};
const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`  ✗ ${message}`);
};
const ok = (message) => console.log(`  ✓ ${message}`);

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function nextBuild(dir, label) {
  const started = Date.now();
  try {
    run(process.execPath, [nextBin, "build"], dir);
    ok(`next build (${label}) succeeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  } catch (error) {
    fail(`next build (${label}) failed:\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(dir, port) {
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status > 0) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`next start on ${port} did not come up:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return child;
}

/** Strips everything that legitimately differs between two builds of the same page. */
function normalizeHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta name="next-size-adjust"[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\b(data-dpl-id|nonce)="[^"]*"/g, "")
    .replace(/[0-9a-f]{20,}/gi, "<hash>")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

function showDiff(label, a, b) {
  const pretty = (s) => s.replace(/></g, ">\n<");
  return createTwoFilesPatch(
    `${label} (before)`,
    `${label} (after)`,
    pretty(a),
    pretty(b),
    undefined,
    undefined,
    { context: 2 },
  )
    .split("\n")
    .slice(0, 60)
    .join("\n");
}

async function domSnapshot(page) {
  // Let framer-motion and transitions settle.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  return normalizeHtml(await page.evaluate(() => globalThis.document.body.outerHTML));
}

async function runStep(page, step) {
  if (step.click) await page.locator(step.click).first().click();
  if (step.fill) await page.locator(step.fill[0]).first().fill(step.fill[1]);
  if (step.select) await page.locator(step.select[0]).first().selectOption(step.select[1]);
  if (step.waitForURL) await page.waitForURL(step.waitForURL);
}

async function scriptSizes(rawHtml, port) {
  // The route's own client JavaScript: the <script src> files its HTML references
  // (prefetches triggered later by <Link> are deliberately not counted).
  const srcs = [...rawHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  let raw = 0;
  let gzip = 0;
  for (const src of new Set(srcs)) {
    const body = Buffer.from(
      await (await fetch(new URL(src, `http://127.0.0.1:${port}`))).arrayBuffer(),
    );
    raw += body.length;
    gzip += gzipSync(body).length;
  }
  return { raw, gzip };
}

/** Builds and serves one phase of an app, and records everything the comparison needs. */
async function capturePhase(app, phase, browser) {
  const source = path.join(appsDir, app);
  const spec = JSON.parse(readFileSync(path.join(source, "e2e.json"), "utf8"));
  // Same directory for both phases: Turbopack derives CSS-module class names from the file path.
  const dir = path.join(tmpDir, app);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  cpSync(source, dir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.next`) && !src.endsWith("next-env.d.ts"),
  });

  if (phase === "after") {
    let report;
    try {
      report = JSON.parse(
        run(process.execPath, [cli, "--root", dir, "--write", "--allow-dirty", "--json"], dir),
      );
    } catch (error) {
      fail(`codemod failed: ${error.stdout ?? ""}${error.stderr ?? ""}`);
      return undefined;
    }
    const byFile = new Map(report.files.map((f) => [f.file, f]));
    for (const file of spec.expectSplit ?? []) {
      const r = byFile.get(file);
      if (r?.status === "split") ok(`split ${file} (${r.islands.map((i) => i.name).join(", ")})`);
      else
        fail(
          `expected ${file} to be split, got ${r?.status ?? "no result"} ${r?.skipped ? `[${r.skipped.code}] ${r.skipped.message}` : ""}`,
        );
    }
    for (const [file, code] of Object.entries(spec.expectSkip ?? {})) {
      const r = byFile.get(file);
      if (r?.skipped?.code === code) ok(`skipped ${file} [${code}]`);
      else
        fail(
          `expected ${file} to be skipped with ${code}, got ${r?.status} ${r?.skipped?.code ?? ""}`,
        );
    }
    for (const r of report.files) {
      if (r.skipped?.code === "self-check-failed" || r.skipped?.code === "internal-error")
        fail(`${r.file}: ${r.skipped.code} ${r.skipped.message}`);
    }
  }

  if (!nextBuild(dir, phase)) return undefined;
  const port = await freePort();
  const server = await startServer(dir, port);
  const routes = [];
  try {
    for (const route of spec.routes) {
      const rawHtml = await (await fetch(`http://127.0.0.1:${port}${route.path}`)).text();
      const context = await browser.newContext({ timezoneId: "UTC", locale: "en-US" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.goto(`http://127.0.0.1:${port}${route.path}`);
      const snapshots = [await domSnapshot(page)];
      let stepError;
      for (const step of route.steps) {
        try {
          await runStep(page, step);
        } catch (error) {
          stepError = `${JSON.stringify(step)}: ${error.message.split("\n")[0]}`;
          break;
        }
        snapshots.push(await domSnapshot(page));
      }
      await context.close();
      routes.push({
        path: route.path,
        steps: route.steps,
        html: normalizeHtml(rawHtml),
        size: await scriptSizes(rawHtml, port),
        snapshots,
        stepError,
        errors: errors.filter((e) => !/favicon/.test(e)),
      });
    }
  } finally {
    server.kill();
  }
  return routes;
}

async function checkApp(app) {
  console.log(`\n▶ ${app}`);
  const browser = await chromium.launch();
  let before;
  let after;
  try {
    before = await capturePhase(app, "before", browser);
    after = await capturePhase(app, "after", browser);
  } catch (error) {
    fail(String(error.stack ?? error));
  } finally {
    await browser.close();
  }
  if (!before || !after) return;

  for (const [i, b] of before.entries()) {
    const a = after[i];
    if (b.html === a.html) ok(`${b.path}: server HTML identical`);
    else fail(`${b.path}: server HTML differs\n${showDiff(b.path, b.html, a.html)}`);
    for (const [label, r] of [
      ["before", b],
      ["after", a],
    ]) {
      if (r.stepError) fail(`${b.path} (${label}): step failed ${r.stepError}`);
      if (r.errors.length > 0)
        fail(`${b.path} (${label}): browser errors: ${r.errors.join(" | ")}`);
    }
    for (const [s, snap] of b.snapshots.entries()) {
      const label =
        s === 0
          ? `${b.path}: hydrated DOM`
          : `${b.path} step ${s} ${JSON.stringify(b.steps[s - 1])}`;
      const other = a.snapshots[s];
      if (other === undefined) continue;
      if (snap === other) ok(`${label}: identical`);
      else fail(`${label}: DOM differs\n${showDiff(label, snap, other)}`);
      const step = b.steps[s - 1];
      if (s > 0 && step?.click && !step.noChange && other === a.snapshots[s - 1]) {
        fail(`${label}: clicking changed nothing in the split build (island not interactive?)`);
      }
    }
  }

  console.log(`\n  Client JavaScript per route, gzip (${app}):`);
  console.log(
    `  ${"route".padEnd(10)} ${"before".padStart(10)} ${"after".padStart(10)} ${"saved".padStart(10)}`,
  );
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  for (const [i, b] of before.entries()) {
    const a = after[i];
    console.log(
      `  ${b.path.padEnd(10)} ${kb(b.size.gzip).padStart(10)} ${kb(a.size.gzip).padStart(10)} ${kb(b.size.gzip - a.size.gzip).padStart(10)}`,
    );
  }
}

for (const app of apps) await checkApp(app);

if (failures.length > 0) {
  console.error(`\ne2e: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\ne2e: all checks passed");
