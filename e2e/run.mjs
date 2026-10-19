// E2E harness: placeholder until the first app lands (milestone 0.3).
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

const appsDir = path.resolve(import.meta.dirname, "apps");
const apps = existsSync(appsDir) ? readdirSync(appsDir).filter((d) => !d.startsWith(".")) : [];
if (apps.length === 0) {
  console.log("e2e: no apps yet");
  process.exit(0);
}
