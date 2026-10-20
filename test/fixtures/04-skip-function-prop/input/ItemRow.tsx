"use client";

type Item = { id: string; name: string; description: string };

export default function ItemRow({ item, onSelect }: { item: Item; onSelect: (id: string) => void }) {
  return (
    <li>
      <h3>{item.name}</h3>
      <p>{item.description}</p>
      <small>#{item.id}</small>
      <button onClick={() => onSelect(item.id)}>Select</button>
    </li>
  );
}
