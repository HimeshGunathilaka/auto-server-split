import { ts } from "ts-morph";
import type { AnalysisContext } from "./context.js";
import { locOf } from "./context.js";
import { describeCall } from "./rules.js";
import type { FileFacts } from "./taint.js";
import type { Warning } from "./warnings.js";

/** Warnings per file, at most; the last one counts the rest. */
const MAX_WARNINGS = 5;

/** Calls the config's `rules.warnings` names that run on the server after the change (`stays`). */
export function findRuleWarnings(
  ctx: AnalysisContext,
  facts: FileFacts,
  stays: (node: ts.Node) => boolean,
): Warning[] {
  const rules = facts.rules;
  if (!rules?.hasCallRules) return [];
  const found: Warning[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && stays(node)) {
      const target = facts.callTarget(node);
      const rule = target && rules.warning(target);
      if (target && rule) {
        found.push({
          code: "rule",
          message: `${describeCall(target)} now runs on the server: ${rule.message}`,
          location: locOf(ctx, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ctx.sf);
  const warnings = found.slice(0, MAX_WARNINGS);
  const more = found.length - MAX_WARNINGS;
  const last = warnings[warnings.length - 1];
  if (more > 0 && last) last.message += ` (and ${more} more like this in the file)`;
  return warnings;
}
