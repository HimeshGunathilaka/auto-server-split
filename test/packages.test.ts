import { describe, expect, it } from "vitest";
import { splitOne } from "./helpers.js";

const island = (f: { outputs: Record<string, string> }) => f.outputs["Comp.client.tsx"] ?? "";
const server = (f: { outputs: Record<string, string> }) => f.outputs["Comp.tsx"] ?? "";

/** A React icon package the tool knows nothing about (depends on React, no "use client"). */
const iconPackage = (name: string, entryDirective = "") => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({
    name,
    main: "index.js",
    types: "index.d.ts",
    peerDependencies: { react: "*" },
  }),
  [`node_modules/${name}/index.js`]: `${entryDirective}export function Mail() { return null; }\n`,
  [`node_modules/${name}/index.d.ts`]: `export declare function Mail(): null;\n`,
});

const usesIcon = (from: string) => `"use client";
import { useState } from "react";
import { Mail } from "${from}";

export default function Comp() {
  const [n, setN] = useState(0);
  return (
    <section>
      <ul>
        <li><Mail /> Email</li>
      </ul>
      <button onClick={() => setN(n + 1)}>{n}</button>
    </section>
  );
}
`;

describe("server-safe packages", () => {
  it("treats an unknown React package as client-only by default", async () => {
    const f = await splitOne(usesIcon("my-icons"), iconPackage("my-icons"));
    expect(f.status).toBe("split");
    expect(f.islands.map((i) => i.rootTag)).toContain("Mail");
    expect(island(f)).toContain('import { Mail } from "my-icons";');
  });

  it("keeps a package listed in serverSafePackages on the server", async () => {
    const f = await splitOne(usesIcon("my-icons"), iconPackage("my-icons"), {
      serverSafePackages: ["my-icons"],
    });
    expect(f.status).toBe("split");
    expect(server(f)).toContain("<li><Mail /> Email</li>");
    expect(island(f)).not.toContain("Mail");
  });

  it("lets serverSafePackages override the built-in client-only list", async () => {
    const f = await splitOne(
      usesIcon("@radix-ui/react-slot"),
      iconPackage("@radix-ui/react-slot"),
      {
        serverSafePackages: ["@radix-ui/react-slot"],
      },
    );
    expect(f.status).toBe("split");
    expect(server(f)).toContain("<Mail />");
  });

  it("knows lucide-react and @tabler/icons-react are server-safe", async () => {
    for (const name of ["lucide-react", "@tabler/icons-react"]) {
      const f = await splitOne(usesIcon(name), iconPackage(name));
      expect(f.status, name).toBe("split");
      expect(server(f), name).toContain("<Mail />");
    }
  });

  it('still treats a server-safe package\'s "use client" entry as client code', async () => {
    // Used as a value (not rendered), a "use client" export is a client reference the server
    // can't read, so the element that reads it stays in the island.
    const source = usesIcon("my-icons").replace("<li><Mail /> Email</li>", "<li>{Mail.name}</li>");
    const safe = await splitOne(source, iconPackage("my-icons"), {
      serverSafePackages: ["my-icons"],
    });
    expect(server(safe)).toContain("<li>{Mail.name}</li>");
    const clientEntry = await splitOne(source, iconPackage("my-icons", `"use client";\n`), {
      serverSafePackages: ["my-icons"],
    });
    expect(server(clientEntry)).not.toContain("Mail.name");
  });
});
