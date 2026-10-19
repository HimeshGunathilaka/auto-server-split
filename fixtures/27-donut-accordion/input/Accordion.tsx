"use client";
import { useState } from "react";
import { format } from "date-fns";
import { marked } from "marked";

type Article = { title: string; author: string; date: string; body: string };

export default function Accordion({ article }: { article: Article }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="accordion">
      <h2>{article.title}</h2>
      <div className="accordion-item">
        <button aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Collapse" : "Expand"} article
        </button>
        <div className="accordion-panel" hidden={!open}>
          <article>
            <header>
              <p className="byline">
                By {article.author} on {format(new Date(article.date), "PPP")}
              </p>
            </header>
            <div dangerouslySetInnerHTML={{ __html: marked(article.body) as string }} />
          </article>
        </div>
      </div>
    </section>
  );
}
