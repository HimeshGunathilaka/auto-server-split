import path from "node:path";
import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { checkSerializable } from "../../src/analysis/serializable.js";
import { DEFAULT_COMPILER_OPTIONS } from "../../src/project/loadProject.js";

const SOURCE = `
import type { ReactNode, ReactElement, JSX } from "react";

interface Author { name: string; joined: Date }
type Post = { id: string; title?: string; tags: string[]; author: Author; meta: Record<string, number> };
enum Color { Red, Green }
class Thing { constructor(public name: string) {} }
type Tree = { label: string; children: Tree[] };
const REGISTERED = Symbol.for("app.key");
const LOCAL = Symbol("local");

declare const ok_string: string;
declare const ok_number: number;
declare const ok_boolean: boolean;
declare const ok_null: null;
declare const ok_undefined: undefined;
declare const ok_bigint: bigint;
declare const ok_literal_union: "a" | "b" | 3;
declare const ok_enum: Color;
declare const ok_optional: string | undefined;
declare const ok_plain_object: { a: string; b: { c: number } };
declare const ok_interface: Author;
declare const ok_nested_alias: Post;
declare const ok_array: number[];
declare const ok_readonly_array: readonly string[];
declare const ok_tuple: [string, number];
declare const ok_record: Record<string, boolean>;
declare const ok_date: Date;
declare const ok_map: Map<string, Post>;
declare const ok_set: Set<number>;
declare const ok_uint8array: Uint8Array;
declare const ok_float64array: Float64Array;
declare const ok_arraybuffer: ArrayBuffer;
declare const ok_promise: Promise<Post>;
declare const ok_react_node: ReactNode;
declare const ok_react_element: ReactElement;
declare const ok_jsx_element: JSX.Element;
declare const ok_form_data: FormData;
declare const ok_recursive: Tree;
declare const ok_symbol_for: typeof REGISTERED;

declare const bad_function: () => void;
declare const bad_method_object: { run(): void };
declare const bad_function_property: { onClick: (e: string) => void };
declare const bad_class_instance: Thing;
declare const bad_any: any;
declare const bad_unknown: unknown;
declare const bad_object_keyword: object;
declare const bad_symbol: symbol;
declare const bad_local_symbol: typeof LOCAL;
declare const bad_map_of_functions: Map<string, () => void>;
declare const bad_promise_of_function: Promise<() => void>;
declare const bad_array_of_functions: Array<() => void>;
declare const bad_regexp: RegExp;
declare const bad_error: Error;
declare const bad_url: URL;
declare const bad_weakmap: WeakMap<object, string>;
declare const bad_union_with_function: string | (() => void);
`;

const project = new Project({ compilerOptions: DEFAULT_COMPILER_OPTIONS });
// Placed inside the repo so "react" resolves to the real @types/react.
const sf = project.createSourceFile(
  path.resolve(import.meta.dirname, "__virtual__/types.tsx"),
  SOURCE,
);
const checker = project.getTypeChecker().compilerObject;

function declared(prefix: string): { name: string; type: ts.Type }[] {
  const out: { name: string; type: ts.Type }[] = [];
  for (const statement of sf.compilerNode.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text.startsWith(prefix)) {
        out.push({ name: decl.name.text, type: checker.getTypeAtLocation(decl.name) });
      }
    }
  }
  return out;
}

describe("checkSerializable", () => {
  const allowed = declared("ok_");
  const rejected = declared("bad_");

  it("found the test declarations", () => {
    expect(allowed.length).toBe(29);
    expect(rejected.length).toBe(17);
  });

  it.each(allowed.map((d) => [d.name, d.type] as const))("allows %s", (_name, type) => {
    expect(checkSerializable(checker, type)).toEqual({ ok: true });
  });

  it.each(rejected.map((d) => [d.name, d.type] as const))("rejects %s", (_name, type) => {
    const verdict = checkSerializable(checker, type);
    expect(verdict.ok).toBe(false);
  });

  it("explains why a nested property fails", () => {
    const [entry] = declared("bad_function_property");
    const verdict = checkSerializable(checker, entry?.type as ts.Type);
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("onClick") });
  });

  it("in untyped (.js) mode allows only primitives", () => {
    const [str] = declared("ok_string");
    const [obj] = declared("ok_plain_object");
    expect(checkSerializable(checker, str?.type as ts.Type, { primitivesOnly: true }).ok).toBe(
      true,
    );
    expect(checkSerializable(checker, obj?.type as ts.Type, { primitivesOnly: true }).ok).toBe(
      false,
    );
  });
});
