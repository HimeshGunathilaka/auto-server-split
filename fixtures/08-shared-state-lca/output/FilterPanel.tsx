import { FilterPanelDiv } from "./FilterPanel.client";

type Props = { heading: string; intro: string; options: string[] };

export default function FilterPanel({ heading, intro, options }: Props) {
  return (
    <section>
      <header>
        <h2>{heading}</h2>
        <p>{intro}</p>
      </header>
      <FilterPanelDiv />
      <ul>
        {options.map((option) => (
          <li key={option}>{option}</li>
        ))}
      </ul>
    </section>
  );
}
