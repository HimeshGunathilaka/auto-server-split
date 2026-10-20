import PostCard from "../components/PostCard";
import Panel from "../components/Panel";
import Mostly from "../components/Mostly";

export default function Page() {
  return (
    <main>
      <PostCard post={{ title: "t", date: "2026-01-01", body: "b" }} />
      <Panel />
      <Mostly title="m" />
    </main>
  );
}
