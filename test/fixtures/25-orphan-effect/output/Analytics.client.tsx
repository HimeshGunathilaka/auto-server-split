"use client";
import { useEffect } from "react";

export function AnalyticsEffects({ page }: { page: string }) {
  useEffect(() => {
    document.title = page;
  }, [page]);
  return null;
}
