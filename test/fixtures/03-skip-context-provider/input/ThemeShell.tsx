"use client";
import { createContext, useState, type ReactNode } from "react";

const ThemeContext = createContext("light");

export default function ThemeShell({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState("light");
  return (
    <ThemeContext.Provider value={theme}>
      <header>
        <h1>My site</h1>
        <p>Welcome</p>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Toggle theme</button>
      </header>
      <main>{children}</main>
    </ThemeContext.Provider>
  );
}
