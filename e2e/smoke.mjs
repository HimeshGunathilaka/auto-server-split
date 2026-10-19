// Runs the built CLI against the first fixture in dry-run mode. Used by the Node 20 CI job.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "fixtures/01-postcard-like-button/input");
if (!existsSync(fixture)) {
  console.log("smoke: no fixture yet, skipping");
  process.exit(0);
}
const out = execFileSync(
  process.execPath,
  [path.join(root, "dist/cli.js"), "PostCard.tsx", "--json"],
  {
    cwd: fixture,
    encoding: "utf8",
  },
);
const report = JSON.parse(out);
const file = report.files.find((f) => f.file === "PostCard.tsx");
if (file?.status !== "split") {
  console.error(out);
  throw new Error("smoke: expected PostCard.tsx to be split");
}
console.log("smoke: ok");
