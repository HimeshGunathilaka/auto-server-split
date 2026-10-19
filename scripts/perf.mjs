// Generates a synthetic 500-file Next.js app and times a dry run (spec section 9: < 15 s).
// Usage: pnpm build && node scripts/perf.mjs [fileCount]
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const count = Number(process.argv[2] ?? 500);
const root = path.join(repo, "test/.tmp/perf");
rmSync(root, { recursive: true, force: true });
const write = (rel, text) => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};

write(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["dom", "esnext"],
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      paths: { "@/*": ["./*"] },
    },
    include: ["**/*.ts", "**/*.tsx"],
  }),
);

const perKind = Math.floor(count / 5);
for (let i = 0; i < perKind; i++) {
  write(
    `lib/util${i}.ts`,
    `export function fmt${i}(n: number): string {\n  return n.toFixed(${i % 4});\n}\n`,
  );
  write(
    `components/server/Card${i}.tsx`,
    `import { fmt${i} } from "@/lib/util${i}";\n\nexport default function Card${i}({ n }: { n: number }) {\n  return (\n    <div>\n      <h3>Card ${i}</h3>\n      <p>{fmt${i}(n)}</p>\n    </div>\n  );\n}\n`,
  );
  write(
    `components/client/Like${i}.tsx`,
    `"use client";\nimport { useState } from "react";\nimport { fmt${i} } from "@/lib/util${i}";\n\ntype Item = { id: string; title: string; body: string };\n\nexport default function Like${i}({ item, n }: { item: Item; n: number }) {\n  const [liked, setLiked] = useState(false);\n  return (\n    <article>\n      <h2>{item.title}</h2>\n      <p>{item.body}</p>\n      <small>{fmt${i}(n)}</small>\n      <button onClick={() => setLiked(!liked)} data-id={item.id}>\n        {liked ? "♥" : "♡"}\n      </button>\n    </article>\n  );\n}\n`,
  );
  write(
    `components/client/Toggle${i}.tsx`,
    `"use client";\nimport { useState } from "react";\n\nexport default function Toggle${i}({ label }: { label: string }) {\n  const [on, setOn] = useState(false);\n  return <button onClick={() => setOn(!on)}>{label}: {on ? "on" : "off"}</button>;\n}\n`,
  );
  write(
    `app/p${i}/page.tsx`,
    `import Card${i} from "@/components/server/Card${i}";\nimport Like${i} from "@/components/client/Like${i}";\nimport Toggle${i} from "@/components/client/Toggle${i}";\n\nexport default function Page() {\n  return (\n    <main>\n      <Card${i} n={${i}} />\n      <Like${i} item={{ id: "${i}", title: "t", body: "b" }} n={${i}} />\n      <Toggle${i} label="x" />\n    </main>\n  );\n}\n`,
  );
}
console.log(`generated ${perKind * 5} files in ${path.relative(repo, root)}`);

for (const flags of [["--no-measure"], []]) {
  const started = Date.now();
  const out = execFileSync(
    process.execPath,
    [path.join(repo, "dist/cli.js"), "--root", root, "--json", ...flags],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const seconds = (Date.now() - started) / 1000;
  const report = JSON.parse(out);
  const split = report.files.filter((f) => f.status === "split").length;
  console.log(
    `dry run ${flags.join(" ") || "(with esbuild measurement)"}: ${seconds.toFixed(1)}s, ${report.files.length} "use client" files, ${split} split`,
  );
}
