# Appearance settings

Appearance settings let a user choose the application mode and confirm that the choice remains after a reload.

## Sub-features

- `settings-open` opens the settings navigator from the Kata menu.
- `mode-system` selects the system-resolved mode.
- `mode-light` selects light mode.
- `mode-dark` selects dark mode.
- `mode-persisted` reads the namespaced theme value after reload.

## How to get to it (user POV)

- Reach the ready shell through `Setup later` in a fresh run.
- Click the top-bar `Kata menu` button.
- Open the `Settings` submenu and choose `Appearance`.
- In the `Mode` control, choose `Dark`, `Light`, or `System`.

## Driving it with Playwright + real Electron

Preconditions:

- `#app-ready` is visible in an isolated run.
- The English locale is active, or use the `data-testid` selectors for the mode controls.

- **Open the page.** Click `getByRole("button", { name: "Kata menu" })`, then hover `getByRole("menuitem", { name: "Settings", exact: true })`, then click `getByRole("menuitem", { name: "Appearance", exact: true })`. Wait for `[data-testid="appearance-mode-dark"]`. The page has two `radiogroup`s (Mode and Font); Font also has a "System" radio.
- **Choose dark.** Click `[data-testid="appearance-mode-dark"]`. The `<html>` element gains the `dark` class.
- **Reload.** Reload the renderer with `waitUntil: "domcontentloaded"`; wait for the ready shell and assert `<html>` still has `dark`.
- **Confirm persistence.** Read the local-storage key ending in `theme` without writing it. Parse its JSON and require `.mode === "dark"` (the object also stores `colorTheme` and `font`).
- **Checked-in regression.** Run `bun run e2e --grep "persists dark theme mode after reload" --trace on`. The existing `@settings` test uses the same real app and persistence assertion.
- **Proof.** Capture the action trace plus a screenshot/ARIA snapshot of the Appearance page and retain the read-back mode value. A clicked control or a dark screenshot without the post-reload value is incomplete proof.

## Gotchas

- The checked-in settings flow may dispatch the stable `settings/appearance` route event to avoid i18n-dependent menu DOM; that is a navigation convenience for the test, not a replacement for the user-facing Kata menu path in a proof artifact.
- Do not set `localStorage` directly; the mode must be changed through the visible control.
- The stored key is namespaced and only guaranteed to end with `theme`; do not hard-code the prefix.
- A system theme can resolve to light or dark; assert the selected explicit mode when proving persistence.
- The settings fixture completes deferred setup before opening settings; starting from onboarding without doing so leaves the Appearance page unreachable.
