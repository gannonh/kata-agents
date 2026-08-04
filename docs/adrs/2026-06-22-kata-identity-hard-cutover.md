---
type: ADR
title: Kata identity hard cutover
description: Canonical runtime and package identity for Kata Agents after the Craft Agents fork
tags: [rebrand, identity, kata]
timestamp: 2026-06-22T00:00:00Z
---

# ADR: Kata identity hard cutover

## Status

Accepted

## Context

Kata Agents forked from Craft Agents with Phase 1 user-facing copy renamed while identity infrastructure (`@craft-agent/*`, `CRAFT_*`, `~/.craft-agent`, `craftagents://`, `com.lukilabs.craft-agent`) remained unchanged. There are no production users requiring backward compatibility.

## Decision

Adopt a single canonical Kata identity graph with zero legacy aliases:

| Surface | Canonical value |
|---------|-----------------|
| Workspace scope | `@kata-sh/*` |
| Root package | `kata-agents` |
| Config directory | `~/.kata-agents` (`KATA_CONFIG_DIR` override) |
| Env prefix | `KATA_*` |
| App ID | `sh.kata.agents` |
| Deep link | `kataagents://` |
| Public host | `agents.kata.sh` |
| CLI / server binaries | `kata-cli`, `kata-server` |

Craft references remain only for upstream LICENSE attribution, historical completed specs, Craft document/source integration (`{source:Craft}`), and unrelated third-party names.

## Consequences

- No migration shims from Craft-era paths, env vars, schemes, or package names.
- Release, OAuth relay, docs MCP, and help links must target `agents.kata.sh`.
- Breaking change for any external automation still using Craft-era identifiers.

## References

- [Complete Kata brand transition spec](../specs/archive/2026-06-22-complete-kata-brand-transition-design.md)
