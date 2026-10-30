"use client";
import { forwardRef, memo, useState } from "react";

export default memo(
  forwardRef<HTMLSpanElement, { text: string }>((props) => {
    const [on, setOn] = useState(false);
    return (
      <p>
        <strong>{props.text}</strong>
        <span onClick={() => setOn(!on)}>{on ? "on" : "off"}</span>
      </p>
    );
  }),
);
