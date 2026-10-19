"use client";
import { createContext, useState, type ReactNode } from "react";

const ThemeContext = createContext("light");

export default function ThemeShell({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState("light");
  return (
    <ThemeContext.Provider value={theme}>
      <div data-theme={theme}>
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Theme: {theme}</button>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
