import PostDetail from "@/components/PostDetail";
import { getPost } from "@/lib/db";

export default function PostPage() {
  return <PostDetail post={getPost()} />;
}
