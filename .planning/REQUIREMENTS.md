# Kata Agents — Requirements

## v0.4.0 Requirements

### Setup & Tooling

- [ ] **SETUP-01**: CI workflow validates builds on PR (GitHub Actions)
- [ ] **SETUP-02**: CI runs test suite on PR (`bun test`)
- [ ] **SETUP-03**: CI produces platform build artifacts (macOS, Windows, Linux)
- [ ] **SETUP-04**: Upstream management strategy documented (tracking, merging, separation)

### Trademark Compliance

- [ ] **BRAND-01**: Remove "Craft" from product name and metadata (package.json, electron-builder.yml)
- [ ] **BRAND-02**: Update bundle ID from `com.lukilabs.craft-agent` to `sh.kata.desktop`
- [ ] **BRAND-03**: Remove/replace `craft.do` domain references in codebase
- [ ] **BRAND-04**: Replace application icons (icns, ico, png) with Kata branding
- [ ] **BRAND-05**: Replace in-app logos and symbols (SVGs, React components)

### Distribution

- [ ] **DIST-01**: Configure GitHub releases for v0.4.0 distribution

## Future Requirements

_Deferred to v0.5.0 or later:_

- Auto-update server endpoint (kata.sh)
- Kata Orchestrator integration
- Kata Context integration

## Out of Scope

- Feature additions during foundation phase — keep scope minimal
- Removing existing features (OAuth, MCP, etc.) — keep everything working
- Custom update server infrastructure — GitHub releases sufficient for now

## Traceability

| Requirement | Phase | Status  |
|-------------|-------|---------|
| SETUP-01    | 1     | Pending |
| SETUP-02    | 1     | Pending |
| SETUP-03    | 1     | Pending |
| SETUP-04    | 1     | Pending |
| BRAND-01    | 2     | Pending |
| BRAND-02    | 2     | Pending |
| BRAND-03    | 2     | Pending |
| BRAND-04    | 2     | Pending |
| BRAND-05    | 2     | Pending |
| DIST-01     | 2     | Pending |

---
*Last updated: 2026-01-29*
