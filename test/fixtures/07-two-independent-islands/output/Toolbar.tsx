import { ToolbarButton, ToolbarButton2 } from "./Toolbar.client";

export default function Toolbar({ title }: { title: string }) {
  return (
    <div className="toolbar">
      <h1>{title}</h1>
      <p>Edit the document below.</p>
      <ToolbarButton />
      <hr />
      <span>Static separator</span>
      <ToolbarButton2 />
    </div>
  );
}
