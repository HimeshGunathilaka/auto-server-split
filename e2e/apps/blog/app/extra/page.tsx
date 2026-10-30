import Field from "@/components/Field";
import MemoStat from "@/components/MemoStat";
import SectionTracker from "@/components/SectionTracker";
import ShareCard from "@/components/ShareCard";

export default function Extra() {
  return (
    <main>
      <SectionTracker section="extra" />
      <MemoStat label="Downloads" value={42} />
      <Field label="Name" hint="Your full name" />
      <ShareCard id="card-1" title="  islands everywhere " />
    </main>
  );
}
