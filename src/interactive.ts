import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import pc from "picocolors";
import type { FileResult } from "./types.js";

export type Rerun = (
  relFile: string,
  renames: Readonly<Record<string, string>>,
) => Promise<FileResult>;

type Io = {
  input: Readable;
  output: Writable;
  colorDiff: (diff: string) => string;
  describe: (file: FileResult) => string;
};

/**
 * Walks through each proposed split: [y]es / [n]o / [r]ename islands / [d]iff / [q]uit.
 * Renames go back through the engine (and its self-check), so a bad name can't produce bad code.
 * Returns the accepted results, with renames applied.
 */
export async function reviewInteractively(
  files: FileResult[],
  rerun: Rerun,
  io: Io,
): Promise<FileResult[]> {
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string | undefined> => {
    io.output.write(question);
    const next = await lines.next();
    return next.done ? undefined : String(next.value).trim();
  };
  const print = (text = "") => io.output.write(`${text}\n`);
  const accepted: FileResult[] = [];

  try {
    review: for (const original of files.filter((f) => f.status === "split")) {
      let current = original;
      const defaults = original.islands.map((i) => i.name);
      const renames: Record<string, string> = {};
      print();
      print(io.describe(current));
      for (;;) {
        const answer = (
          await ask(
            `Apply this split? ${pc.bold("[y]")}es / ${pc.bold("[n]")}o / ${pc.bold("[r]")}ename islands / ${pc.bold("[d]")}iff / ${pc.bold("[q]")}uit: `,
          )
        )?.toLowerCase();
        if (answer === undefined || answer === "q") break review;
        if (answer === "y") {
          accepted.push(current);
          break;
        }
        if (answer === "n") break;
        if (answer === "d") {
          print(io.colorDiff(current.diff));
          continue;
        }
        if (answer === "r") {
          const proposed = { ...renames };
          for (const [i, island] of current.islands.entries()) {
            if (island.moved) continue;
            const name = await ask(`  Rename ${island.name} to (enter to keep): `);
            if (name === undefined) break review;
            const original = defaults[i];
            if (name && original) proposed[original] = name;
          }
          const result = await rerun(current.file, proposed);
          if (result.status === "split") {
            Object.assign(renames, proposed);
            current = result;
            print(io.describe(current));
          } else {
            print(pc.yellow(`  Rename rejected: ${result.skipped?.message ?? "unknown reason"}`));
          }
          continue;
        }
        print("  Please answer y, n, r, d or q.");
      }
    }
  } finally {
    rl.close();
  }
  return accepted;
}
