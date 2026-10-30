import { spawn } from "node:child_process";

/** One command `auto-server-split verify` ran. */
export type VerificationStep = {
  command: string;
  /** null when the command was killed by a signal. */
  exitCode: number | null;
  durationMs: number;
  /** The last lines it printed (stdout and stderr), when its output was captured. */
  outputTail?: string;
};

/** What `auto-server-split verify` did: every command it ran, in order, and whether all passed. */
export type Verification = {
  passed: boolean;
  steps: VerificationStep[];
  /** Commands not run because an earlier one failed. */
  notRun: string[];
};

const TAIL_LINES = 30;

/**
 * Runs the config's `verify.commands` in `cwd`, one after another, through the shell, and stops at
 * the first that fails unless `keepGoing`. With `capture`, output is collected (its tail is kept for
 * the report) instead of passed through to the terminal; with `echo` too, it's collected and still
 * shown. Nothing is rolled back: verification only reports.
 */
export async function runVerification(
  commands: readonly string[],
  cwd: string,
  options: {
    capture?: boolean;
    echo?: boolean;
    keepGoing?: boolean;
    onStart?: (command: string) => void;
  } = {},
): Promise<Verification> {
  const steps: VerificationStep[] = [];
  const notRun: string[] = [];
  let failed = false;
  for (const command of commands) {
    if (failed && !options.keepGoing) {
      notRun.push(command);
      continue;
    }
    options.onStart?.(command);
    const started = Date.now();
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
        env: process.env,
      });
      let output = "";
      const collect = (to: NodeJS.WriteStream) => (chunk: Buffer) => {
        if (options.echo) to.write(chunk);
        output += chunk.toString("utf8");
        // Keep memory bounded on chatty builds: only the tail is reported.
        if (output.length > 200_000) output = output.slice(-100_000);
      };
      child.stdout?.on("data", collect(process.stdout));
      child.stderr?.on("data", collect(process.stderr));
      child.on("error", (error) => resolve({ code: 127, output: `${output}${error.message}\n` }));
      child.on("close", (code) => resolve({ code, output }));
    });
    const step: VerificationStep = {
      command,
      exitCode: result.code,
      durationMs: Date.now() - started,
      ...(options.capture
        ? { outputTail: result.output.trimEnd().split("\n").slice(-TAIL_LINES).join("\n") }
        : {}),
    };
    steps.push(step);
    if (result.code !== 0) failed = true;
  }
  return { passed: !failed && notRun.length === 0, steps, notRun };
}
