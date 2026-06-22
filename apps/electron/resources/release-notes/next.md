# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Redesigned update experience** — The app now checks for updates in the background and surfaces an `Update available` pill in the sidebar instead of auto-downloading. Click to download, then `Restart to update` to install on your schedule. A new Settings → About **Update track** selector switches between **Stable** and **Nightly**; the installed build supplies the default, and your choice persists and takes effect immediately. The macOS app menu `Check for Updates…` now shows a native up-to-date or failure dialog. Production builds now keep an updater diagnostics log for troubleshooting.

## Improvements

## Bug Fixes

- **Correct update version source** — Settings and the macOS `Check for Updates…` dialog now read the installed Electron app version, keeping Stable/Nightly checks consistent with the macOS About panel.
- **Restore macOS app icon sizing** — macOS release builds now use the `AppIcon.icns` packaging path and copy Liquid Glass assets into Nightly bundles correctly, matching Kata Code's desktop icon setup.

## Breaking Changes
