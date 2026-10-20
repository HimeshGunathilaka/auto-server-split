"use client";
import { useState } from "react";

type Todo = { id: number; title: string; notes: string };

export default function TodoList({ title, todos }: { title: string; todos: Todo[] }) {
  const [done, setDone] = useState<number[]>([]);
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
      <footer>
        {todos.map((todo) => (
          <label key={todo.id}>
            <input type="checkbox" checked={done.includes(todo.id)} onChange={() => setDone([...done, todo.id])} />
            {todo.title}
          </label>
        ))}
      </footer>
    </section>
  );
}
