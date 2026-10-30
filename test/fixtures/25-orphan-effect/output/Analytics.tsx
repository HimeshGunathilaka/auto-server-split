import { AnalyticsEffects } from "./Analytics.client";

export default function Analytics({ page }: { page: string }) {
  return (
    <div>
      <h1>{page}</h1>
      <p>Welcome</p>
      <AnalyticsEffects page={page} />
    </div>
  );
}
