import { addComment } from "../actions";
import CommentBox from "../CommentBox";

export default function Page() {
  return <CommentBox post={{ id: "1", title: "Hello", summary: "First post" }} onSubmit={addComment} />;
}
