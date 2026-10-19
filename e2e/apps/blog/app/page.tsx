import PostCard from "@/components/PostCard";
import Toolbar from "@/components/Toolbar";
import FilterPanel from "@/components/FilterPanel";
import LikeCard from "@/components/LikeCard";
import Accordion from "@/components/Accordion";
import Banner from "@/components/Banner";
import { article, post } from "@/lib/data";

export default function Home() {
  return (
    <main>
      <Banner message="Welcome to the e2e blog" />
      <PostCard post={post} />
      <Toolbar title="Toolbar" />
      <FilterPanel heading="Filters" intro="Pick a tag" options={["react", "next", "rsc"]} />
      <LikeCard post={{ id: "42", title: "Liked post", excerpt: "Short and sweet" }} count={3} />
      <Accordion article={article} />
    </main>
  );
}
