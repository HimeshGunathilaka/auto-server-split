import Badge from "../components/Badge";
import { Field } from "../components/Field";
import { MemoArrow } from "../components/MemoArrow";
import Panel from "../components/Panel";

export default function Page() {
  return (
    <main>
      <MemoArrow title="Hello" body="**hi**" />
      <Panel heading="Panel" />
      <Field label="Name" hint="Your full name" />
      <Badge text="Badge" />
    </main>
  );
}
