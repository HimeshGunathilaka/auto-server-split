import { GreetingButton } from "./_islands/Greeting.client";

export type Person = { name: string; city: string };

export default function Greeting({ person }: { person: Person }) {
  return (
    <section>
      <h2>Hello</h2>
      <p>From {person.city}</p>
      <GreetingButton person={{ name: person.name }} />
    </section>
  );
}
