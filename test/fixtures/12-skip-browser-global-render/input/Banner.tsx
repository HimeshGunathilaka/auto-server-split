"use client";

export default function Banner({ message }: { message: string }) {
  const wide = typeof window !== "undefined" && window.innerWidth > 800;
  return (
    <div className={wide ? "banner banner--wide" : "banner"}>
      <strong>Notice</strong>
      <p>{message}</p>
      <small>{wide ? "Desktop" : "Mobile"} layout</small>
    </div>
  );
}
