"use client";
import { useState } from "react";

type Todo = { id: number; title: string; notes: string };

export function TodoListFooter({ todos }: { todos: Todo[] }) {
  const [done, setDone] = useState<number[]>([]);
  return (
    <footer>
      {todos.map((todo) => (
        <label key={todo.id}>
          <input type="checkbox" checked={done.includes(todo.id)} onChange={() => setDone([...done, todo.id])} />
          {todo.title}
        </label>
      ))}
    </footer>
  );
}
