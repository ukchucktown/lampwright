import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests build real fixture trees on disk. Windows runners are several
    // times slower at that than macOS or Linux — one file takes 24s there
    // against about 1s locally — so the 5s default made the suite pass or
    // fail on timing rather than behaviour. The budget is generous because
    // it exists to remove flakiness, not to bound a real assertion.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
