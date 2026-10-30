import { marked } from "marked";
import { MemoArrowButton } from "./MemoArrow.client";

export const MemoArrow = ({ title, body }: { title: string; body: string }) => {
  return (
    <section>
      <h2>{title}</h2>
      <div dangerouslySetInnerHTML={{ __html: marked(body) as string }} />
      <MemoArrowButton />
    </section>
  );
};
