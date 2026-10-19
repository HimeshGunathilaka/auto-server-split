"use server";

const likes = new Map<string, number>();

export async function likePost(id: string): Promise<number> {
  const next = (likes.get(id) ?? 0) + 1;
  likes.set(id, next);
  return next;
}

export async function addComment(postId: string, text: string): Promise<string> {
  return `Saved "${text}" on ${postId}`;
}
