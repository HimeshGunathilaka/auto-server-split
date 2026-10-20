import path from "node:path";
import { describe, expect, it } from "vitest";
import { split } from "../src/index.js";

// The exact expected output from the README example, kept inline so regenerating
// fixtures (UPDATE_FIXTURES=1) can never silently change it.
const SERVER = `import { format } from "date-fns";
import { marked } from "marked";
import { PostCardButton } from "./PostCard.client";

type Post = { title: string; date: string; body: string };

export default function PostCard({ post }: { post: Post }) {
  return (
    <article>
      <h2>{post.title}</h2>
      <time>{format(new Date(post.date), "PPP")}</time>
      <div dangerouslySetInnerHTML={{ __html: marked(post.body) as string }} />
      <PostCardButton />
    </article>
  );
}
`;

const ISLAND = `"use client";
import { useState } from "react";

export function PostCardButton() {
  const [liked, setLiked] = useState(false);
  return <button onClick={() => setLiked(!liked)}>{liked ? "♥" : "♡"}</button>;
}
`;

describe("README example: PostCard like button", () => {
  it("produces exactly the specified output, with the size measured", async () => {
    const root = path.resolve(import.meta.dirname, "fixtures/01-postcard-like-button/input");
    const result = await split({ root, paths: ["PostCard.tsx"] });
    const file = result.files.find((f) => f.file === "PostCard.tsx");
    expect(file?.skipped).toBeUndefined();
    expect(file?.status).toBe("split");
    expect(file?.outputs).toEqual({ "PostCard.tsx": SERVER, "PostCard.client.tsx": ISLAND });
    expect(file?.islands).toEqual([
      { name: "PostCardButton", rootTag: "button", props: [], line: 15 },
    ]);
    expect(file?.staticRatio).toBeCloseTo(0.8);
    // date-fns and marked leave the client bundle.
    expect(file?.bytesSaved?.conservative).toBeGreaterThan(2048);
  });
});
