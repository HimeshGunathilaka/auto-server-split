import { CommentItemDiv, LikeButton } from "./CommentThread.client";

type Comment = { id: string; author: string; text: string };

function Avatar({ name }: { name: string }) {
  return <span className="avatar">{name.slice(0, 1)}</span>;
}

export function CommentItem({ comment }: { comment: Comment }) {
  return (
    <li>
      <strong>{comment.author}</strong>
      <CommentItemDiv comment={comment} />
      <LikeButton initial={0} />
    </li>
  );
}

export default function CommentThread({ title, comments }: { title: string; comments: Comment[] }) {
  return (
    <section>
      <h2>
        <Avatar name={title} /> {title}
      </h2>
      <ul>
        {comments.map((c) => (
          <CommentItem key={c.id} comment={c} />
        ))}
      </ul>
      <LikeButton initial={comments.length} />
    </section>
  );
}
