import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import type { JNode } from "../../src/analysis/islands.js";
import { lowestCommonAncestor } from "../../src/analysis/islands.js";

let nextId = 0;
function node(parent?: JNode, rootIndex = 0): JNode {
  const j: JNode = {
    id: nextId++,
    node: ts.factory.createJsxFragment(
      ts.factory.createJsxOpeningFragment(),
      [],
      ts.factory.createJsxJsxClosingFragment(),
    ),
    parent,
    children: [],
    rootIndex,
    fnBetween: [],
    depth: parent ? parent.depth + 1 : 0,
  };
  parent?.children.push(j);
  return j;
}

describe("lowestCommonAncestor", () => {
  //        root
  //       /    \
  //      a      b
  //     / \      \
  //    a1  a2     b1
  //    |
  //    a1x
  const root = node();
  const a = node(root);
  const b = node(root);
  const a1 = node(a);
  const a2 = node(a);
  const b1 = node(b);
  const a1x = node(a1);

  it("of a single node is the node", () => expect(lowestCommonAncestor([a1])).toBe(a1));
  it("of siblings is the parent", () => expect(lowestCommonAncestor([a1, a2])).toBe(a));
  it("of nodes at different depths", () => expect(lowestCommonAncestor([a1x, a2])).toBe(a));
  it("of a node and its descendant is the ancestor", () =>
    expect(lowestCommonAncestor([a1x, a])).toBe(a));
  it("across subtrees is the root", () => expect(lowestCommonAncestor([a1x, b1])).toBe(root));
  it("of many nodes", () => expect(lowestCommonAncestor([a1x, a2, a1])).toBe(a));
  it("is undefined across render roots", () => {
    const other = node(undefined, 1);
    expect(lowestCommonAncestor([a1, other])).toBeUndefined();
  });
  it("is undefined for no nodes", () => expect(lowestCommonAncestor([])).toBeUndefined());
});
