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
    "    fromNow(): string;",
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

  it("warns about date-fns functions that print the local offset, like formatISO()", async () => {
    const result = await splitOne(
      card(
        "      <span>{formatISO(new Date(date))}</span>",
        'import { formatISO } from "date-fns";',
      ),
    );
    expect(codes(result)).toEqual(["timezone-dependent@8"]);
    expect(result.warnings?.[0]?.message).toContain("formatISO() from date-fns");
  });

  it("warns through optional chaining on a Date that may be undefined", async () => {
    const result = await splitOne(`"use client";
import { useState } from "react";

export default function Card({ at }: { at?: Date }) {
  const [open, setOpen] = useState(false);
  return (
    <article>
      <span>{at?.getHours()}</span>
      <button onClick={() => setOpen(!open)}>{open ? "Less" : "More"}</button>
    </article>
  );
}
`);
    expect(codes(result)).toEqual(["timezone-dependent@8"]);
  });

  it("warns when a helper imported from another project file formats the date", async () => {
    const result = await splitOne(
      card("      <span>{formatStamp(date)}</span>", 'import { formatStamp } from "./lib/dates";'),
      {
        "lib/dates.ts": `import { format } from "date-fns";

export function formatStamp(iso: string) {
  return format(new Date(iso), "yyyy-MM-dd HH:mm");
}
`,
      },
    );
    expect(codes(result)).toEqual(["timezone-dependent@8"]);
    expect(result.warnings?.[0]?.message).toBe(
      "formatStamp() calls format() from date-fns (lib/dates.ts:4), which uses the timezone of the machine that renders it, now the server; format with an explicit timezone (date-fns-tz's formatInTimeZone) or keep it in an island",
    );
  });
});

describe("calls that read the current time", () => {
  const island = (result: Awaited<ReturnType<typeof splitOne>>) =>
    Object.entries(result.outputs).find(([file]) => file.endsWith(".client.tsx"))?.[1] ?? "";

  it("keeps date-fns calls that compare with now in an island, like Date.now()", async () => {
    for (const call of [
      "formatDistanceToNow(new Date(date))",
      'isToday(new Date(date)) ? "today" : ""',
    ]) {
      const name = call.slice(0, call.indexOf("("));
      const result = await splitOne(
        card(`      <span>{${call}}</span>`, `import { ${name} } from "date-fns";`),
      );
      expect(result.status).toBe("split");
      expect(result.warnings).toBeUndefined();
      expect(result.islands.map((i) => i.rootTag)).toContain("span");
      expect(island(result)).toContain(`${name}(`);
    }
  });

  it("keeps dayjs() without a date and .fromNow() in an island", async () => {
    for (const expr of ['dayjs().format("HH:mm")', "dayjs(date).fromNow()"]) {
      const result = await splitOne(
        card(`      <span>{${expr}}</span>`, 'import dayjs from "dayjs";'),
        dayjsStub,
      );
      expect(result.status).toBe("split");
      expect(result.islands.map((i) => i.rootTag)).toContain("span");
      expect(island(result)).toContain(expr);
    }
  });
});

describe("ignore comments outside the header", () => {
  it("warns that a comment after the imports doesn't apply", async () => {
    const result = await splitOne(
      card("      <h2>Title</h2>").replace(
        "export default function",
        "// auto-server-split-ignore: too late here\nexport default function",
      ),
    );
    expect(result.status).toBe("split");
    expect(codes(result)).toEqual(["ignore-outside-header@4"]);
    expect(result.warnings?.[0]?.message).toContain("isn't in the file header");
  });
});
