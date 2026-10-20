import { formatPrice } from "@/lib/format";
import { PriceTagButton } from "./PriceTag.client";

export default function PriceTag({ name, cents }: { name: string; cents: number }) {
  return (
    <div>
      <h4>{name}</h4>
      <p>{formatPrice(cents)} each</p>
      <PriceTagButton cents={cents} />
    </div>
  );
}
