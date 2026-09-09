import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:1425",
    viewport: { width: 1440, height: 1000 },
    timezoneId: "Asia/Seoul",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run preview --host 127.0.0.1 --port 1425",
    url: "http://127.0.0.1:1425",
    // Never silently reuse a stale local preview server; only reuse inside CI.
    reuseExistingServer: !process.env.CI,
  },
});
