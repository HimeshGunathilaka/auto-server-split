// formatTitle is server-safe; markShared reads `document`, but only when it's called.
export function formatTitle(title: string): string {
  return title.trim().toUpperCase();
}

export function markShared(id: string): void {
  document.body.dataset.shared = id;
}
