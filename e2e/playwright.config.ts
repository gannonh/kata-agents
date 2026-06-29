import "./src/config/loadEnv.ts";

import { defineConfig, devices } from "@playwright/test";

import { E2E_TIMEOUTS } from "./src/config/timeouts.ts";
import { isVideoEnabled, readWorkerCount } from "./src/harness/env.ts";
import { resolveE2eRoot } from "./src/harness/artifacts.ts";

const e2eRoot = resolveE2eRoot();
const webUrl = process.env["KATA_WEBUI_E2E_URL"] ?? "http://localhost:9100";
const shouldStartWebServer = process.argv.some((arg) => (
  arg === "web-dev" ||
  arg.endsWith("=web-dev") ||
  arg.includes("tests/web/") ||
  arg.includes("e2e/tests/web/")
));
const WEB_TEST_MATCH = /web\/.*\.spec\.ts/;
const WEB_TEST_IGNORE = WEB_TEST_MATCH;

export default defineConfig({
  testDir: "./tests",
  outputDir: `${e2eRoot}/test-results/playwright`,
  fullyParallel: false,
  workers: readWorkerCount(),
  retries: 0,
  timeout: E2E_TIMEOUTS.testMs,
  expect: {
    timeout: E2E_TIMEOUTS.assertionMs,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: `${e2eRoot}/playwright-report`, open: "never" }],
    ["json", { outputFile: `${e2eRoot}/test-results/results.json` }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: isVideoEnabled() ? "retain-on-failure" : "off",
    ...devices["Desktop Chrome"],
  },
  projects: [
    {
      name: "desktop-dev",
      testMatch: /.*\.spec\.ts/,
      testIgnore: WEB_TEST_IGNORE,
      metadata: { launchTarget: "dev" },
    },
    {
      name: "desktop-release",
      testMatch: /.*\.spec\.ts/,
      testIgnore: WEB_TEST_IGNORE,
      metadata: { launchTarget: "release" },
    },
    {
      name: "web-dev",
      testMatch: WEB_TEST_MATCH,
      use: {
        baseURL: webUrl,
      },
    },
  ],
  webServer: shouldStartWebServer
    ? {
      command: "bash scripts/start-web-e2e-server.sh",
      url: webUrl,
      reuseExistingServer: true,
      timeout: 120_000,
    }
    : undefined,
});
