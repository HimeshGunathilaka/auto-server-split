import { PanelButton } from "./Panel.client";

const Panel = function Panel({ heading }: { heading: string }) {
    return (
      <div>
        <h3>{heading}</h3>
        <p>Static text that stays on the server.</p>
        <PanelButton />
      </div>
    );
  };

export default Panel;
