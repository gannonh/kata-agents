/**
 * Starter template for recording WebUI tests with Playwright CodeGen.
 *
 * Workflow:
 *   1. Start the WebUI stack: bun run server:dev:webui
 *   2. Record a new flow:     bun run e2e:codegen
 *   3. Interact with the WebUI in the browser.
 *   4. Copy the generated code below.
 *   5. Run:                  bun run e2e:web
 *
 * Keep recorded selectors as a draft. After recording, replace brittle CSS or
 * text selectors with stable roles, labels, or explicit test ids before relying
 * on the test as branch coverage.
 */
import { expect, test } from "@playwright/test";

test.describe("WebUI recorded flows", () => {
  test.skip("recording template loads the configured WebUI URL", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/.*/);
  });

  // Paste CodeGen output below this line. Keep each recorded flow in its own
  // test(...) block, then tighten selectors and assertions before committing it
  // as coverage for a product behavior.
});
