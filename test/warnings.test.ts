import { describe, expect, it } from "vitest";
import { splitOne } from "./helpers.js";

const dayjsStub = {
  "node_modules/dayjs/package.json": JSON.stringify({ name: "dayjs", types: "index.d.ts" }),
  "node_modules/dayjs/index.d.ts": [
    "declare namespace dayjs {",
    "  class Dayjs {",
    "    format(template?: string): string;",
    "    utc(): Dayjs;",
    "    add(n: number, unit: string): Dayjs;",
    "  }",
    "}",
    "declare function dayjs(date?: string): dayjs.Dayjs;",
    "export = dayjs;",
  ].join("\n"),
};

const card = (body: string, imports = "") => `"use client";
import { useState } from "react";
${imports}
export default function Card({ date }: { date: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
${body}
      <button onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>
    </article>
  );
}
`;

const codes = (result: Awaited<ReturnType<typeof splitOne>>) =>
  (result.warnings ?? []).map((w) => `${w.code}@${w.location?.line}`);

describe("timezone warnings", () => {
  it("warns when date-fns formatting moves to the server", async () => {
    const result = await splitOne(
      card(
        `      <time>{format(new Date(date), "PPP")}</time>`,
        'import { format } from "date-fns";',
      ),
    );
    expect(result.status).toBe("split");
    expect(codes(result)).toEqual(["timezone-dependent@8"]);
    expect(result.warnings?.[0]?.message).toContain("format() from date-fns");
  });

  it("doesn't warn about code that stays in an island", async () => {
    const result = await splitOne(`"use client";
import { format } from "date-fns";
import { useState } from "react";

export default function Card({ date }: { date: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
      <h2>Title</h2>
      <button onClick={() => setOpen(!open)}>{open ? format(new Date(date), "PPP") : "More"}</button>
    </article>
  );
}
`);
    expect(result.status).toBe("split");
    expect(result.warnings).toBeUndefined();
  });

  it("warns about Date's local getters, not the UTC ones", async () => {
    const local = await splitOne(card("      <span>{new Date(date).getHours()}</span>"));
    expect(codes(local)).toEqual(["timezone-dependent@8"]);
    const utc = await splitOne(card("      <span>{new Date(date).getUTCHours()}</span>"));
    expect(utc.warnings).toBeUndefined();
  });

  it("warns about dayjs .format() unless the value was put in a zone", async () => {
    const plain = await splitOne(
      card(
        '      <span>{dayjs(date).add(1, "day").format("D MMM")}</span>',
        'import dayjs from "dayjs";',
      ),
      dayjsStub,
    );
    expect(codes(plain)).toEqual(["timezone-dependent@8"]);
    expect(plain.warnings?.[0]?.message).toContain("on a dayjs value");
    const zoned = await splitOne(
      card('      <span>{dayjs(date).utc().format("D MMM")}</span>', 'import dayjs from "dayjs";'),
      dayjsStub,
    );
    expect(zoned.warnings).toBeUndefined();
  });

  it("warns on a removed directive too", async () => {
    const result = await splitOne(
      `"use client";
import { format } from "date-fns";

export default function Stamp({ date }: { date: string }) {
  return <time>{format(new Date(date), "PPP")}</time>;
}
`,
      {},
      { removeUnusedDirectives: true },
    );
    expect(result.status).toBe("directive-removed");
    expect(codes(result)).toEqual(["timezone-dependent@5"]);
  });
});
