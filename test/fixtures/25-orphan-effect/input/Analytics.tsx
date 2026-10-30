"use client";
import { useEffect } from "react";

export default function Analytics({ page }: { page: string }) {
  useEffect(() => {
    document.title = page;
  }, [page]);
  return (
    <div>
      <h1>{page}</h1>
      <p>Welcome</p>
    </div>
  );
}
