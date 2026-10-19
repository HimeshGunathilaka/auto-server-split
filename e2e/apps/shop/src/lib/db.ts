import type { IProduct, PostDoc } from "./models";

// Stand-ins for database reads. As in many real apps, the values are plain JSON at runtime
// (string ids) while the types still say ObjectId / HydratedDocument.
export function getProducts(): IProduct[] {
  return [
    { _id: "65f000000000000000000001", name: "Kettle", price: 3900, categoryId: "65f0000000000000000000aa" },
    { _id: "65f000000000000000000002", name: "Teapot", price: 2500, categoryId: null },
  ] as unknown as IProduct[];
}

export function getPost(): PostDoc {
  return {
    _id: "65f000000000000000000099",
    title: "Brewing notes",
    body: "Water just off the boil.",
    likes: 7,
    createdAt: new Date("2026-04-02T10:00:00Z"),
    author: { name: "Grace", id: "65f0000000000000000000bb" },
  } as unknown as PostDoc;
}
