import { ClapperButton } from "./Clapper.client";

export default function Clapper({ title, initial = 0 }) {
  return (
    <div>
      <h2>{title}</h2>
      <p>Enjoyed it?</p>
      <ClapperButton initial={initial} />
    </div>
  );
}
