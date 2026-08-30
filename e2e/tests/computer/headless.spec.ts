import { test as playwrightTest } from "@playwright/test";
import { platform } from "node:os";

import { assertNoFatalLaunchErrors } from "../../src/assertions/appAssertions.ts";
import { E2E_TAGS } from "../../src/config/tags.ts";
import { test as electronTest, expect } from "../../src/fixtures/testFixtures.ts";
import {
  formatMissingPrerequisiteError,
  readComputerHeadlessPrerequisite,
} from "../../src/harness/env.ts";

const COMPUTER_HEADLESS_TIMEOUT_MS = 10 * 60 * 1000;

playwrightTest.describe(`Headless computer prerequisites ${E2E_TAGS.computerHeadless}`, () => {
  playwrightTest("requires the deployed computer URL and token", () => {
    const prerequisite = readComputerHeadlessPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError(
          "Headless computer E2E",
          prerequisite.missing,
        ),
      );
    }
  });
});

electronTest.describe.configure({ mode: "serial", timeout: COMPUTER_HEADLESS_TIMEOUT_MS });

electronTest.describe(`Headless computer thin client ${E2E_TAGS.computerHeadless}`, () => {
  electronTest("connects the desktop thin client to the shared computer", async ({
    launchedApp,
    appWindow,
  }) => {
    const prerequisite = readComputerHeadlessPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError(
          "Headless computer E2E",
          prerequisite.missing,
        ),
      );
    }
    if (platform() !== "darwin") {
      throw new Error(
        "Thin-client GUI for @computer-headless requires macOS. Run this spec on a macOS GUI session against a Linux Docker computer. See e2e/README.md.",
      );
    }

    await expect(appWindow.locator("#root")).toBeAttached();
    assertNoFatalLaunchErrors(launchedApp.readFatalErrors());
  });
});
