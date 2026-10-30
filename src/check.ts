import { formatBytes, isChange } from "./split.js";
import type { FileResult, ResolvedConfig } from "./types.js";

/** What `--check` decided, and why. */
export type CheckOutcome = {
  /** True when `--check` should exit 2. */
  failed: boolean;
  /** The changes that fail the check on their own. */
  failing: FileResult[];
  /** One line per reason the check failed. */
  reasons: string[];
};

/**
 * Applies the config's `check` settings to the available changes (baselined ones already left out):
 *
 * - Without settings, every available change fails the check.
 * - `minSaving` / `minRouteSaving`: only changes that save at least that much (in total, or up front
 *   on one route) fail it; either is enough when both are set.
 * - `maxRecoverable`: the check fails when the changes together save more than this. Set on its own
 *   (without a per-change threshold), it replaces the any-change rule.
 * - `maxNewBoundaries`: the check fails when more `"use client"` files than this aren't in the
 *   baseline's boundaries. Also replaces the any-change rule when it's the only setting.
 */
export function evaluateCheck(
  changes: readonly FileResult[],
  check: ResolvedConfig["check"],
  newBoundaries: readonly string[] | undefined,
): CheckOutcome {
  const available = changes.filter(isChange);
  const perChange = check.minSaving !== undefined || check.minRouteSaving !== undefined;
  const budgets = check.maxRecoverable !== undefined || check.maxNewBoundaries !== undefined;
  const reasons: string[] = [];
  let failing: FileResult[] = [];
  if (perChange || !budgets) {
    failing = available.filter((f) => {
      if (!perChange) return true;
      const total = f.bytesSaved?.conservative;
      const route = Math.max(
        0,
        ...(f.routes ?? []).map((r) => (r.load === "initial" ? (r.bytesSaved ?? 0) : 0)),
      );
      return (
        (check.minSaving !== undefined && total !== undefined && total >= check.minSaving) ||
        (check.minRouteSaving !== undefined && route >= check.minRouteSaving)
      );
    });
    if (failing.length > 0) {
      const which = perChange
        ? ` that save${failing.length === 1 ? "s" : ""} at least ${[
            check.minSaving !== undefined ? formatBytes(check.minSaving) : undefined,
            check.minRouteSaving !== undefined
              ? `${formatBytes(check.minRouteSaving)} on a route`
              : undefined,
          ]
            .filter(Boolean)
            .join(" or ")}`
        : "";
      reasons.push(
        `${failing.length} change${failing.length === 1 ? " is" : "s are"} available${which}`,
      );
    }
  }
  if (check.maxRecoverable !== undefined) {
    const total = available.reduce((n, f) => n + (f.bytesSaved?.conservative ?? 0), 0);
    if (total > check.maxRecoverable) {
      // Rounded sizes can print the same ("5.7 KB, more than 5.7 KB"); then show bytes.
      const [a, b] = [formatBytes(total), formatBytes(check.maxRecoverable)];
      const [shown, limit] = a === b ? [`${total} B`, `${check.maxRecoverable} B`] : [a, b];
      reasons.push(`the available changes save ${shown}, more than maxRecoverable (${limit})`);
    }
  }
  if (check.maxNewBoundaries !== undefined && newBoundaries) {
    if (newBoundaries.length > check.maxNewBoundaries)
      reasons.push(
        `${newBoundaries.length} "use client" file${newBoundaries.length === 1 ? " isn't" : "s aren't"} in the baseline (maxNewBoundaries is ${check.maxNewBoundaries}): ${newBoundaries.slice(0, 5).join(", ")}${newBoundaries.length > 5 ? ", ..." : ""}`,
      );
  }
  return { failed: reasons.length > 0, failing, reasons };
}
