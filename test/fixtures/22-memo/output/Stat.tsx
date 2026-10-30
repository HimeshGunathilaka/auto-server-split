import { StatButton } from "./Stat.client";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <StatButton />
    </div>
  );
}

export default Stat;
