import ProductRow from "@/components/ProductRow";
import Cart from "@/components/Cart";
import Newsletter from "@/components/Newsletter";
import { getProducts } from "@/lib/db";

export default function Home() {
  const products = getProducts();
  return (
    <main>
      <table>
        <tbody>
          {products.map((p) => (
            <ProductRow key={p.name} product={p} />
          ))}
        </tbody>
      </table>
      <Cart
        lines={[
          { sku: "k1", name: "Kettle", cents: 3900 },
          { sku: "t1", name: "Teapot", cents: 2500 },
        ]}
      />
      <Newsletter heading="Stay in touch" perks={2} />
    </main>
  );
}
