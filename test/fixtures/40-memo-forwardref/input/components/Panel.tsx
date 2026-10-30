"use client";
import React, { useState } from "react";

const Panel = React.memo(
  function Panel({ heading }: { heading: string }) {
    const [count, setCount] = useState(0);
    return (
      <div>
        <h3>{heading}</h3>
        <p>Static text that stays on the server.</p>
        <button onClick={() => setCount(count + 1)}>{count}</button>
      </div>
    );
  },
  (a, b) => a.heading === b.heading,
);

export default Panel;
