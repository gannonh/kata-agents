/**
 * Playwright CodeGen config for recording WebUI flows.
 *
 * Usage:
 *   1. Start the WebUI stack you want to record against.
 *      For the local dev bundle, use: bun run server:dev:webui
 *   2. Record: bun run e2e:codegen
 *   3. Copy the generated code into e2e/tests/web/recorded.spec.ts.
 *   4. Replace `page` with the provided `page` fixture or move stable flows into
 *      dedicated specs under e2e/tests/web/.
 *
 * This records browser/WebUI flows. Electron tests still need hand-authored
 * Playwright steps because Playwright CodeGen does not record `_electron.launch`.
 */
import { defineConfig, devices } from "@playwright/test";

const webUrl = process.env["KATA_WEBUI_E2E_URL"] ?? "http://localhost:5175";

export default defineConfig({
  testDir: "./tests/web",
  outputDir: "./test-results/codegen",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"]],
  use: {
    baseURL: webUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    {
      name: "web-codegen",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
