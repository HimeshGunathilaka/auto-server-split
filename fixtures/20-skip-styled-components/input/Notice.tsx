"use client";
import { useState } from "react";
import styled from "styled-components";

const Box = styled.div`
  padding: 1rem;
`;

export default function Notice({ text }: { text: string }) {
  const [hidden, setHidden] = useState(false);
  return (
    <Box>
      <p>{text}</p>
      <p>Static footnote</p>
      <button onClick={() => setHidden(!hidden)}>{hidden ? "Show" : "Hide"}</button>
    </Box>
  );
}
