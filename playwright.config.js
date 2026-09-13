import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 20_000,
  fullyParallel: false,
  use: {
    channel:
      process.env.PLAYWRIGHT_CHANNEL ||
      (process.platform === "win32" ? "msedge" : "chromium"),
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
});
