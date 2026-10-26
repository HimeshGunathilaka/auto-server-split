import PostCard from "./PostCard";
import { ShelfButton } from "./Shelf.client";

export default function Shelf() {
  return (
    <section>
      <PostCard post={{ title: "Pinned", date: "2026-01-01", body: "Pinned post" }} />
      <ShelfButton />
    </section>
  );
}
