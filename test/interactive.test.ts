import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { reviewInteractively } from "../src/interactive.js";
import { runSplit } from "../src/split.js";

async function review(answers: string[]) {
  const root = path.resolve(import.meta.dirname, "fixtures/07-two-independent-islands/input");
  const report = await runSplit({
    root,
    paths: ["."],
    measure: false,
    noConfigFile: true,
    config: { minBytesSaved: 0 },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (d) => (printed += String(d)));
  input.end(answers.map((a) => `${a}\n`).join(""));
  const accepted = await reviewInteractively(report.files, report.rerun, {
    input,
    output,
    colorDiff: (d) => d,
    describe: (f) => `FILE ${f.file} ${f.islands.map((i) => i.name).join(",")}`,
  });
  return { accepted, printed };
}

describe("interactive review", () => {
  it("accepts with y", async () => {
    const { accepted } = await review(["y"]);
    expect(accepted.map((f) => f.file)).toEqual(["Toolbar.tsx"]);
  });

  it("skips with n and stops with q", async () => {
    expect((await review(["n"])).accepted).toEqual([]);
    expect((await review(["q"])).accepted).toEqual([]);
  });

  it("shows the diff with d, then asks again", async () => {
    const { accepted, printed } = await review(["d", "y"]);
    expect(printed).toContain("+++ b/Toolbar.client.tsx");
    expect(accepted).toHaveLength(1);
  });

  it("renames islands through the engine", async () => {
    const { accepted, printed } = await review(["r", "BoldToggle", "", "y"]);
    expect(printed).toContain("FILE Toolbar.tsx BoldToggle,ToolbarButton2");
    const [file] = accepted;
    expect(file?.islands.map((i) => i.name)).toEqual(["BoldToggle", "ToolbarButton2"]);
    expect(file?.outputs["Toolbar.tsx"]).toContain(
      'import { BoldToggle, ToolbarButton2 } from "./Toolbar.client";',
    );
    expect(file?.outputs["Toolbar.client.tsx"]).toContain("export function BoldToggle()");
  });

  it("rejects invalid names and keeps the previous result", async () => {
    const { accepted, printed } = await review(["r", "not-a-name", "", "y"]);
    expect(printed).toContain("Rename rejected");
    expect(accepted[0]?.islands.map((i) => i.name)).toEqual(["ToolbarButton", "ToolbarButton2"]);
  });

  it("rejects names that collide with the file's own names", async () => {
    const { printed } = await review(["r", "Toolbar", "", "n"]);
    expect(printed).toContain("already used");
  });

  it("asks about a removed directive without offering a rename", async () => {
    const root = path.resolve(import.meta.dirname, "fixtures/35-remove-unused-directive/input");
    const report = await runSplit({
      root,
      measure: false,
      noConfigFile: true,
      iterate: false,
      config: { minBytesSaved: 0, removeUnusedDirectives: true },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (d) => (printed += String(d)));
    input.end("r\ny\n");
    const accepted = await reviewInteractively(report.files, report.rerun, {
      input,
      output,
      colorDiff: (d) => d,
      describe: (f) => `FILE ${f.file}`,
    });
    expect(printed).toContain("Remove the directive? [y]es / [n]o / [d]iff / [q]uit");
    expect(printed).toContain("Please answer y, n, d or q.");
    expect(accepted.map((f) => `${f.file}:${f.status}`)).toEqual([
      "components/Sidebar.tsx:directive-removed",
    ]);
  });
});
