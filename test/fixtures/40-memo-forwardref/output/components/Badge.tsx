import { BadgeSpan } from "./Badge.client";

export default (props: { text: string }) => {
    return (
      <p>
        <strong>{props.text}</strong>
        <BadgeSpan />
      </p>
    );
  };
