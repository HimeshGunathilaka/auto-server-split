import type { Review } from "./types";
import { ReviewListDiv } from "./ReviewList.client";

export default function ReviewList({ reviews, title }: { reviews: Review[]; title: string }) {
  return (
    <section>
      <h2>{title}</h2>
      <p>{reviews.length} reviews</p>
      <ReviewListDiv reviews={reviews} />
    </section>
  );
}
