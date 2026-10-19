import Hero from "@/components/Hero";
import Card from "@/components/Card";
import PriceTag from "@/components/PriceTag";
import CommentBox from "@/components/CommentBox";
import ArticleFooter from "@/components/ArticleFooter";
import ClientPanel from "@/components/ClientPanel";
import { addComment } from "@/app/actions";

export default function Misc() {
  return (
    <main>
      <Hero title="Islands" subtitle="Ship less JavaScript" />
      <Card title="CSS modules" body="Classes on both sides" />
      <PriceTag name="Coffee" cents={450} />
      <CommentBox post={{ id: "p1", title: "Comments", summary: "Say something" }} onSubmit={addComment} />
      <ClientPanel />
      <ArticleFooter author="Ada" updated="2026-03-01" />
    </main>
  );
}
