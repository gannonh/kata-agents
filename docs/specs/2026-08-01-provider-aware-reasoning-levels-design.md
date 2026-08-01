---
type: Spec
title: Provider-aware reasoning levels
description: Restore model-specific reasoning level settings for OpenAI and Pi-managed providers, including ChatGPT/Codex connections.
status: Implemented
---

# Provider-aware reasoning levels

## Status
Implemented

## Goal

Expose the reasoning levels supported by the selected model in the chat composer and AI settings, with OpenAI API, ChatGPT/Codex, and other Pi-managed connections using the same capability metadata as the Pi runtime.

## Verified current state

- The shared session setting has seven levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Pi model definitions already contain provider-specific `thinkingLevelMap` metadata, but the renderer-facing `ModelDefinition` currently retains only `supportsThinking`.
- The Pi subprocess maps the shared setting to Pi levels and lets Pi clamp the result against the active model. Pi treats a `null` map value as unsupported, treats omitted lower-tier values as supported, and requires explicit map entries for `xhigh` and `max` support.
- The renderer shows the same generic level list for every model, so it cannot expose Pi's `minimal` level or hide unsupported levels.
- Persisted Pi connection model arrays may contain string IDs. Renderer-facing connection responses need to recover catalog capabilities for those entries without changing provider-scoped model identity.

## Scope

### In scope

- Add the Pi-compatible `minimal` reasoning level to the shared level vocabulary and all validation surfaces.
- Add renderer-safe supported-level metadata to model definitions.
- Derive supported levels from native Pi model metadata and Copilot model discovery where the provider reports reasoning efforts.
- Hydrate capabilities for string-only Pi model entries in renderer-facing LLM connection responses.
- Filter and normalize reasoning controls in:
  - the full chat composer model menu,
  - the compact model selector,
  - app-level AI settings,
  - workspace-level AI settings.
- Preserve the shared `max` setting and use native Pi `max` when the selected model reports it.
- Add focused unit and integration coverage plus a release-note entry.

### Out of scope

- Changing provider request formats or replacing Pi's runtime reasoning implementation.
- Adding reasoning controls to arbitrary custom endpoints that report no capability metadata.
- Reworking the existing app and workspace default precedence rules.
- Changing the Anthropic adaptive-thinking behavior beyond making the new shared level safe for that backend.

## Design

### Shared vocabulary and capability contract

Extend `ThinkingLevel` with `minimal`. Keep the shared ordering as `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Map `minimal` to a low Anthropic effort when a persisted/session value reaches the Claude backend. Map `minimal` directly to Pi's `minimal` level and `max` directly to native Pi `max`. Models without native `max` omit it from their reported capabilities and clamp stale values at runtime.

Add `supportedThinkingLevels?: ThinkingLevel[]` to `ModelDefinition`. This is renderer-safe metadata and does not expose Pi SDK types to Vite. Pi model conversion derives this list from the SDK's supported levels using the semantics above. The model metadata contains the native shared levels reported by Pi; the renderer does not synthesize levels absent from the catalog. Static Anthropic definitions retain the existing Anthropic-oriented levels. Models without capability metadata use the existing shared list as a compatibility default, while an explicit empty list means that no selectable reasoning level was reported.

### Model discovery and connection data flow

1. Pi model conversion creates `ModelDefinition` entries with `supportsThinking` and `supportedThinkingLevels`.
2. Native OpenAI and OpenAI-Codex catalogs expose their Pi registration maps and derived supported levels to the renderer.
3. Copilot model discovery maps reported reasoning efforts into supported shared levels when available.
4. The renderer-facing LLM connection listing enriches string-only Pi model entries from the provider catalog. Unknown custom IDs remain unchanged and use the compatibility default.
5. Existing runtime init and `set_thinking_level` messages continue carrying the shared level. Pi remains responsible for request-level provider mapping and final clamping.

### Renderer behavior

Each reasoning control resolves the selected model's supported levels before rendering. Unsupported options are omitted. Pi models render native `xhigh` and `max` only when the catalog reports them. The current selected value is normalized to the nearest available value for display when a model switch leaves a previously selected level unavailable. Normalization follows the shared order `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, with upward candidates preferred on ties. If the model has no reported capabilities, the control uses the shared compatibility list. If the model explicitly reports no levels or is non-reasoning, the control is disabled or hidden according to the existing UI surface.

User selections are restricted to the rendered supported options. Stale values from IPC, automation, or persisted sessions remain accepted by the shared vocabulary and are safely clamped by the Pi runtime before provider requests. The renderer's normalization is a display and selection guard, not a replacement for that runtime safety boundary.

The app-level and workspace-level settings use the effective connection and model when determining their options. Workspace model overrides take precedence over the effective connection's default model for this calculation. When no model is selected, the connection default model is used; when no connection is available, the shared compatibility list is used.

### Validation and persistence

The new level is accepted by shared validators, session commands, automation/spawn schemas, and persisted config normalization. Existing persisted values remain valid. A value selected for one provider may be clamped or normalized when the user switches to a model with a narrower capability set.

## Acceptance criteria

1. `ThinkingLevel` and every validation/schema surface accept `minimal`, and existing values including `max` remain accepted. Persisted `minimal` values round-trip through config, workspace, session, and automation paths.
2. Pi model conversion follows Pi's `getSupportedThinkingLevels` semantics for `null`, omitted, and explicit `xhigh` and `max` map entries. An OpenAI model with `off: null` and `xhigh` support exposes native `minimal`, `low`, `medium`, `high`, and `xhigh` metadata; `max` appears only when Pi reports an explicit `max` mapping.
3. Pi model conversion exposes the supported levels for a ChatGPT/Codex model using its native `minimal`, `xhigh`, and `max` map entries. GPT-5.6 Sol, Terra, and Luna come from the Pi 0.83 native catalogs.
4. All renderer-facing model conversion paths expose capability metadata: native Pi catalogs, Copilot reported reasoning efforts, and provider-model IPC responses. Unknown effort labels are ignored without dropping the model.
5. A renderer-facing Pi connection whose `models` entries are strings receives matching capability metadata from a provider-scoped catalog lookup when the IDs exist. OpenAI and `openai-codex` entries with the same model ID use their own provider map. Ordering, duplicate entries, and unknown custom IDs are preserved.
6. The full composer and compact selector render only supported reasoning levels for the selected model, include `minimal` where supported, and do not render a selectable `off` option when the model marks it unsupported.
7. App-level and workspace-level AI settings render the same model-specific reasoning options as the chat selectors, including the effective workspace model when one is configured and the shared compatibility list when no model metadata is available.
8. Switching to a model that does not support the current level displays the deterministic nearest supported level. User selection cannot send a level omitted by the rendered capability list; stale values remain accepted and are clamped by the Pi runtime.
9. `max` remains accepted for persisted/session/tool input and maps to native Pi `max` when the selected model supports it. Pi model controls omit `max` when the catalog does not report it; stale values normalize for display and are clamped by the runtime. Anthropic controls retain their existing `max` option.
10. Focused tests cover every model conversion path, provider-scoped hydration, unknown/empty/non-reasoning capability states, normalization tie-breaking, `minimal` to Anthropic-low mapping, native `max` mapping, level validation, and renderer-level option filtering. The shared package, Pi agent server, and Electron type checks pass.
11. The bundled Electron Pi server is regenerated and a smoke assertion confirms the bundle contains the `minimal` mapping and still handles `set_thinking_level`.
12. `apps/electron/resources/release-notes/next.md` and the relevant OKF navigation/history files document the user-visible reasoning-level restoration.

## Implementation phases

1. **Shared capability model**
   - Extend the level vocabulary, translations, validation schemas, backend mappings, and model definition type.
   - Add pure helpers for supported-level filtering and current-level normalization.
2. **Provider metadata propagation**
   - Update native Pi model conversion.
   - Update Copilot discovery and the provider-model IPC response.
   - Enrich renderer-facing connection model entries when persisted IDs lack metadata.
3. **Renderer controls**
   - Replace generic level lists in the full composer, compact selector, and AI settings with the shared capability helper.
   - Handle current-level normalization during model changes.
4. **Verification and documentation**
   - Add focused tests, run package type checks and i18n checks, update release notes and OKF records, and perform a manual selector review if the Electron harness is available.

## Testing and verification

- `bun test packages/shared/tests/models-pi.test.ts packages/shared/src/config/__tests__/default-thinking-level.test.ts packages/shared/src/agent/__tests__/spawn-session-thinking-level.test.ts`
- Pi agent server native-catalog, capability-conversion, and hydration tests.
- Shared validator, storage, automation, and backend mapping tests, including malformed/unknown IPC values.
- `cd packages/shared && bun run tsc --noEmit`
- `cd packages/pi-agent-server && bun run typecheck`
- `cd apps/electron && bun run typecheck`
- Regenerate `apps/electron/resources/pi-agent-server/index.js` through the repository build path and run a bundled-runtime smoke assertion for the new Pi mapping.
- `bun run lint:i18n:parity`
- `bun run lint:i18n:sorted`
- Manual or E2E review of OpenAI API and ChatGPT/Codex model menus when credentials and the Electron harness are available.

## Risks and mitigations

- **Old string-only model entries lack metadata.** Enrich them from the main-process catalog and leave unknown IDs untouched.
- **A persisted `max` value may outlive a model switch.** Normalize the displayed value and map it to native Pi `max` only when the selected model reports that level.
- **Provider catalogs may report no reasoning map.** Use the existing shared compatibility list and avoid inventing a narrower capability set.
- **Adding a shared level touches multiple schemas and locales.** Derive validation from the canonical IDs where possible and run parity/sorted checks.

## Build handoff

Implement the approved scope in the four phases above. Keep one capability contract, `ModelDefinition.supportedThinkingLevels`, between main-process provider discovery and renderer controls. Do not change provider request adapters or unrelated default precedence. Verify each acceptance criterion with focused tests or a documented manual check. If a provider reports an unknown reasoning effort, preserve the model and surface only known shared levels.
