# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.6] - 2026-01-31

### Fixed
- **CRITICAL**: Fix arm64 macOS builds not being notarized - each CI job was building both architectures but only notarizing one, causing the un-notarized build to overwrite the notarized one in releases
- Upload only the specific architecture files from each job to prevent cross-contamination
- Add architecture-specific artifact verification

## [0.4.5] - 2026-01-31

### Fixed
- Make notarization REQUIRED - workflow fails if notarization fails (never skip silently)
- Add notarization verification step to confirm app is properly signed
- Regenerated icons from updated source.png

## [0.4.4] - 2026-01-31

### Fixed
- Fix macOS Liquid Glass icon to display correctly with proper squircle shape
- Rename icon asset catalog to AppIcon.icon for correct CFBundleIconName matching

## [0.4.3] - 2026-01-30

### Fixed
- Fix release workflow reporting false failures due to duplicate file uploads

## [0.4.2] - 2026-01-30

### Fixed
- Enable macOS notarization using ZIP submission workaround (Apple's service hangs on DMG submissions)
- DMG now contains properly notarized app - no more Gatekeeper warnings
- Fix duplicate yml file conflicts in release workflow

## [0.4.1] - 2026-01-30

### Fixed
- Fix Liquid Glass icon size on macOS 26+ (scale adjustment in asset catalog)
- Stop tracking workspace-specific files (sessions, sources, labels, statuses)

## [0.4.0] - 2026-01-30

### Added
- Complete Kata Agents branding (icons, logos, React components)
- macOS code signing support
- CI/CD workflows for PR validation and releases
- GitHub Releases distribution for all platforms
- Upstream management documentation (UPSTREAM.md)

### Fixed
- Remove all craft.do domain references from active code
- Update config paths from .craft-agent to .kata-agents
- Harden GitHub Actions workflows with fork protection
- Strip executable permissions from bundled scripts to improve notarization compatibility

### Changed
- Rebrand from Craft Agents to Kata Agents
- Bundle ID changed to `sh.kata.desktop`
- Auto-update provider changed from generic to GitHub Releases
- Slack OAuth temporarily disabled (requires infrastructure)

### Known Issues
- **macOS Installation (v0.4.0 only)**: If you downloaded v0.4.0, you may need to run `xattr -cr /Applications/Kata\ Agents.app` before opening. This is fixed in v0.4.2+.

## [0.3.0] - 2026-01-28

Initial fork from Craft Agents with Apache 2.0 license compliance.
