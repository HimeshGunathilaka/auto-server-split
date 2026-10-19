import { format } from "date-fns";
import { marked } from "marked";
import { AccordionDiv } from "./Accordion.client";

type Article = { title: string; author: string; date: string; body: string };

export default function Accordion({ article }: { article: Article }) {
  return (
    <section className="accordion">
      <h2>{article.title}</h2>
      <AccordionDiv>
        <article>
          <header>
            <p className="byline">
              By {article.author} on {format(new Date(article.date), "PPP")}
            </p>
          </header>
          <div dangerouslySetInnerHTML={{ __html: marked(article.body) as string }} />
        </article>
      </AccordionDiv>
    </section>
  );
}
