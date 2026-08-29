# Embedded browser panel

The embedded browser panel lets a user create a shared browser instance, move it between the panel and a detached window, hide it without destroying the instance, and enable Annotate on a loaded page.

## Sub-features

- `browser-create` creates a browser from the Add panel menu.
- `browser-panel` displays the instance in `#browser-panel`.
- `browser-detach` moves the same instance to a detached browser window.
- `browser-attach` returns that instance to the panel.
- `browser-hide` hides the panel while retaining the instance.
- `browser-annotate` enables and disables the Annotate control on a loaded page.

## How to get to it (user POV)

- Reach the ready shell.
- Click the top-bar `Add panel menu` button and choose `New Browser`.
- Use the browser tab's `Browser options` / `… actions` menu to choose `Open in Window` or `Return to Panel`. Hide the panel with Close; Hide Browser is on the detached window.
- Navigate the browser to a page and click `Annotate` when the page is eligible.

## Driving it with Playwright + real Electron

Preconditions:

- `#app-ready` is visible in a harness-owned run.
- For the Annotate sub-feature, use the checked-in data-URL fixture; it contains a button with ID `e2e-annotate-target` and needs no network.

- **Create.** Click `getByRole("button", { name: "Add panel menu" })`, then `getByRole("menuitem", { name: "New Browser" })`. Wait for `#browser-panel` and record its `data-browser-instance-id`.
- **Round-trip the instance.** Open the browser tab badge whose accessible name ends in `actions`; choose `Open in Window`, assert `#browser-panel` disappears, choose `Return to Panel`, assert the panel returns with the same `data-browser-instance-id`. Hide via the panel Close control (`common.close`), not Hide Browser on the tab badge. Hide Browser lives on the detached window's Browser options menu. After hide, the panel is absent and the instance still appears in the browser list.
- **Load the fixture.** Navigate the recorded instance to the `annotateFixtureUrl()` data URL from `e2e/src/flows/browser.ts`. Wait for `#browser-annotate-toggle` to be enabled (guest `#e2e-annotate-target` is inside the BrowserView, not the Playwright page).
- **Toggle Annotate.** Assert `#browser-annotate-toggle` is enabled, click it, require `aria-pressed="true"`, click it again, and require `aria-pressed="false"`.
- **Checked-in structural coverage.** Run `bun run e2e --grep "Embedded browser panel" --trace on`. Do not use `--grep @browser` for this proof: that tag also runs provider-backed `annotations.spec.ts`. The structural tests preserve the instance ID through detach/attach via `electronAPI.browserPane` and the Annotate enabled/disabled state.
- **Proof.** Capture the panel/toolbar after creation, the detached and reattached states, and the read-only instance list. For annotations, capture `#browser-annotation-tray` and the user comment when the provider-backed send path is exercised.

## Gotchas

- BrowserViews are native Electron contents, not Playwright `Page` objects. Use the existing webContents adapter for guest-page input; do not replace it with coordinates in the app window.
- Annotate is disabled for `about:blank` and until the guest page is loaded; wait for the fixture and the enabled control.
- Hiding a panel is not terminating the browser. Prove retention with the instance list and only terminate a fixture-created instance during cleanup.
- Sending an annotation to a session is provider-backed and belongs to the credentialed `e2e/tests/browser/annotations.spec.ts` path, not the offline structural test.
- Use the tab badge's stable accessible name (`… actions`) and menu labels rather than assuming a tab's position in the top bar. Hide on the panel is Close, not Hide Browser.
