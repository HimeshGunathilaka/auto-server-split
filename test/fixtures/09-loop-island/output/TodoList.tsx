import { TodoListFooter } from "./TodoList.client";

type Todo = { id: number; title: string; notes: string };

export default function TodoList({ title, todos }: { title: string; todos: Todo[] }) {
  return (
    <section>
      <h2>{title}</h2>
      <p>{todos.length} items</p>
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <h3>{todo.title}</h3>
            <p>{todo.notes}</p>
          </li>
        ))}
      </ul>
      <TodoListFooter todos={todos} />
    </section>
  );
}
