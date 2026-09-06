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
    command: "npm run preview -- --host 127.0.0.1 --port 1425",
    url: "http://127.0.0.1:1425",
    reuseExistingServer: true,
  },
});
