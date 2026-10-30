import { FieldInput } from "./Field.client";

type FieldProps = { label: string; hint: string };

export const Field = function Field({ label, hint }: FieldProps) {
  return (
    <label>
      <span>{label}</span>
      <small>{hint}</small>
      <FieldInput />
    </label>
  );
};
