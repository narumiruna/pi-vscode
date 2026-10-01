import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["out/test/**/*.test.js"],
    pool: "forks",
    // Real Git/process integration tests can exceed the default five seconds.
    testTimeout: 30_000,
    // Avoid saturating the host with concurrent fixture processes.
    maxWorkers: 4,
  },
});
