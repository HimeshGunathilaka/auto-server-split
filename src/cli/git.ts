import { execFileSync } from "node:child_process";

/**
 * Target files that git can't restore: modified, staged, untracked or ignored. Undefined when git
 * can't tell us (not a repository).
 */
export function dirtyFiles(cwd: string, files: string[]): string[] | undefined {
  if (files.length === 0) return [];
  try {
    const out = execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain",
        "--ignored",
        "--untracked-files=all",
        "--",
        ...files,
      ],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map(
        (l) =>
          `${l.slice(3)}${l.startsWith("!!") ? " (ignored by git)" : l.startsWith("??") ? " (untracked)" : ""}`,
      );
  } catch {
    return undefined;
  }
}

/**
 * Files changed since `ref` (committed on this branch since it forked, modified, or untracked),
 * relative to `root`. Undefined when git can't tell (not a repository, unknown ref, shallow clone).
 */
export function changedFiles(root: string, ref: string): string[] | undefined {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    // -z: paths as they are, not quoted and escaped (git quotes non-ASCII names otherwise).
    const out = [
      git("diff", "--name-only", "-z", "--relative", "--diff-filter=ACMR", `${ref}...HEAD`),
      git("diff", "--name-only", "-z", "--relative", "--diff-filter=ACMR", "HEAD"),
      git("ls-files", "-z", "--others", "--exclude-standard"),
    ];
    return [...new Set(out.join("\0").split("\0").filter(Boolean))];
  } catch {
    return undefined;
  }
}
