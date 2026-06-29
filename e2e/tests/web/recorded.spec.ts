/**
 * Starter template for recording WebUI tests with Playwright CodeGen.
 *
 * Workflow:
 *   1. Record a new flow:     bun run e2e:codegen
 *   2. Interact with the WebUI in the browser.
 *   3. Copy the generated code below.
 *   4. Run:                  bun run e2e:web
 *
 * `webPage` is already authenticated and on "/" with the app shell visible.
 * Replace or extend the test below with your recorded actions. Keep recorded
 * selectors as a draft — tighten to stable roles, labels, or test ids before
 * relying on a flow as durable coverage.
 */
import { webTest as test, expect } from "../../src/harness/webSetup.ts";

test.describe("WebUI recorded flows", () => {
  test("authenticated shell loads", async ({ webPage }) => {
    await expect(webPage.locator("#root")).toBeAttached();
  });

  // Paste CodeGen output below this line. Keep each recorded flow in its own
  // test(...) block, then tighten selectors and assertions before committing it
  // as coverage for a product behavior.
});
