# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **macOS Gatekeeper warning**: Apple notarization is delayed due to a [known service issue](https://developer.apple.com/forums/thread/811968) affecting Electron apps. On first launch, right-click the app and select "Open" to bypass the warning. Notarization will be added in a future release.

## [0.3.0] - 2026-01-28

Initial fork from Craft Agents with Apache 2.0 license compliance.
