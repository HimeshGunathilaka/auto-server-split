import { defineConfig } from "auto-server-split";

export default defineConfig({
  include: ["src/**"],
  minBytesSaved: 0,
  minStaticRatio: 0.2,
  mongoose: { autoSerialize: true },
});
