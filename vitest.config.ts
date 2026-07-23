import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-function unit tests — no DOM, no network.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
