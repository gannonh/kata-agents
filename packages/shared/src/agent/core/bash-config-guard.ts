/**
 * Focused Bash config-write mutation guard (pre-tool-use).
 *
 * Restores a narrower replacement for the broad config-domain Bash redirect
 * guard that was removed together with the phantom `kata-agent` CLI (#5).
 * This guard only reasons about statically identifiable shell mutations that
 * target validator-recognized Kata config files:
 *
 * 1. A derivable POSIX `cat <<'DELIM' > target` heredoc routes its exact
 *    content through the same validation path as the `Write` tool. Valid
 *    content proceeds with the command unchanged; invalid or empty content
 *    blocks with the real formatted validation errors.
 * 2. Any other identifiable mutation (redirect, pipeline, tee, append,
 *    chaining, wrapper shell, sed -i, script argument, PowerShell/CMD write)
 *    targeting a recognized config is blocked with guidance to use a
 *    validated tool.
 *
 * Design invariants:
 *
 * - Classification uses IMMUTABLE default permissions only (SAFE_MODE_CONFIG
 *   plus the app-level permissions/default.json). Workspace and source
 *   permissions.json files are themselves guarded configuration, so merged
 *   custom patterns can never influence config-write integrity decisions.
 *   Commands accepted by the immutable-default read-only classifier (e.g.
 *   `cat labels/config.json`, `grep x config.json`) are unaffected.
 * - Relative targets resolve with `path.resolve(workingDirectory ??
 *   workspaceRootPath, target)`; workspace boundary and sibling-prefix
 *   rejection come from `detectConfigFileType`.
 * - The guard never claims to detect arbitrary program behavior
 *   (`python update.py` with no identifiable target is a documented residual
 *   risk), and it does not resurrect the phantom CLI contract.
 */

import { resolve } from 'node:path';
import {
  detectConfigFileType,
  detectAppConfigFileType,
  type ConfigFileDetection,
} from '../../config/validators.ts';
import { isReadOnlyBashCommandWithConfig, extractBashWriteTarget } from '../mode-manager.ts';
import { extractPowerShellWriteTarget } from '../powershell-validator.ts';
import { getImmutableDefaultBashConfig } from '../permissions-config.ts';

// ============================================================
// Results
// ============================================================

export type BashConfigGuardResult =
  | { kind: 'continue' }
  | { kind: 'validate'; detection: ConfigFileDetection; content: string }
  | { kind: 'block'; reason: string };

// ============================================================
// Classification
// ============================================================

/**
 * Classify a Bash command for the pre-tool-use config-write guard.
 *
 * @param command - The original Bash command (before any RTK rewriting).
 * @param workspaceRootPath - Absolute workspace root used for config detection.
 * @param workingDirectory - Optional absolute cwd for resolving relative targets.
 */
export function classifyBashConfigWrite(
  command: string,
  workspaceRootPath: string,
  workingDirectory?: string,
  appConfigDir?: string
): BashConfigGuardResult {
  const trimmed = command.trim();
  if (!trimmed) return { kind: 'continue' };

  // 1. Commands accepted by the immutable-default read-only classifier are
  //    unaffected — reads like `cat labels/config.json` keep existing behavior.
  //    In-place editors with a write flag (-i) are never read-only: a default
  //    pattern like `^sed\s+-n\b` also matches `sed -n -i ...`, which still
  //    edits files in place. They must fall through to mutation detection.
  if (!hasInPlaceEditFlag(trimmed) && isReadOnlyBashCommandWithConfig(trimmed, getImmutableDefaultBashConfig(appConfigDir))) {
    return { kind: 'continue' };
  }

  // 2. Derivable `cat <<'DELIM' > target` heredoc → validate exact content.
  const heredoc = parseDerivableCatHeredoc(trimmed);
  if (heredoc) {
    const detection = detectForTarget(heredoc.target, workspaceRootPath, workingDirectory, appConfigDir);
    if (!detection) return { kind: 'continue' };
    return { kind: 'validate', detection, content: heredoc.content };
  }

  // 3. Identifiable opaque mutations targeting a recognized config → block.
  const opaqueDetection = findOpaqueRecognizedTarget(trimmed, workspaceRootPath, workingDirectory, appConfigDir);
  if (opaqueDetection) {
    return { kind: 'block', reason: buildOpaqueBlockReason(opaqueDetection) };
  }

  return { kind: 'continue' };
}

/** Commands that edit their operands in place when given `-i`. */
const IN_PLACE_EDITORS = new Set(['sed', 'perl', 'ruby', 'awk']);

/**
 * True when the command invokes an in-place editor (`sed`, `perl`, `ruby`,
 * `awk`) with an `-i` flag. Such commands are never read-only, even when a
 * default read-only pattern (e.g. `^sed\s+-n\b`) happens to match: `sed -n -i`
 * still edits the file in place, and GNU awk's `-i inplace` mutates too.
 *
 * Detected before the read-only fast path so these commands reach mutation
 * detection instead of continuing as "read-only".
 */
function hasInPlaceEditFlag(command: string): boolean {
  const head = command.split('\n')[0] ?? command;
  const tokens = tokenizeShellLine(head);
  const consumer = tokens?.[0]?.text ?? '';
  const basename = consumer.split('/').pop();
  if (!basename || !IN_PLACE_EDITORS.has(basename)) return false;
  return tokens?.some((t) => t.kind === 'word' && t.text.startsWith('-i') && t.text.length > 1) ?? false;
}

// ============================================================
// Derivable heredoc grammar
// ============================================================

/**
 * Parsed derivable heredoc: the static redirect target and the exact content
 * the shell would feed to it.
 */
export interface CatHeredoc {
  target: string;
  content: string;
}

/**
 * Parse a derivable POSIX `cat <<'DELIM' > target` heredoc from a raw command.
 *
 * Accepted shape (exactly):
 * - Consumer: `cat` or an absolute path whose basename is `cat`. No flags or
 *   file operands.
 * - Exactly one `<<'DELIM'` or `<<"DELIM"` (quoted delimiter only; `<<-` and
 *   bare `<<DELIM` are rejected).
 * - Exactly one `>` redirect to a static target (no `>>`, no expansions, no
 *   globs); the heredoc and redirect may appear in either order.
 * - No pipeline, chaining (`;`/`&&`/`||`), grouping, backgrounding,
 *   substitution, extra redirect, or extra command.
 * - The heredoc body is every line up to the exact terminator line; anything
 *   non-empty after the terminator would be a separate command and is opaque.
 *
 * Returns null when the command is not exactly this shape (in which case it
 * must be treated as opaque). Content semantics match the shell: body lines
 * joined with `\n` plus a trailing `\n`; an empty body yields `''` (which is
 * still content and must be validated).
 */
export function parseDerivableCatHeredoc(command: string): CatHeredoc | null {
  const firstNewline = command.indexOf('\n');
  const head = firstNewline === -1 ? command : command.slice(0, firstNewline);
  const rest = firstNewline === -1 ? '' : command.slice(firstNewline + 1);

  const tokens = tokenizeShellLine(head);
  if (!tokens || tokens.length === 0) return null;

  // Consumer must be exactly `cat` or an absolute path whose basename is `cat`.
  const first = tokens[0];
  if (!first) return null;
  const consumer = first.text;
  if (consumer !== 'cat' && !/^\/(?:[^/]+\/)*cat$/.test(consumer)) return null;

  let heredocDelim: string | null = null;
  let target: string | null = null;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) return null;
    if (token.kind === 'op') {
      if (token.text === '<<' || token.text === '<<-') {
        // `<<-` strips leading tabs from the body — not derivable.
        if (token.text === '<<-') return null;
        const delim = tokens[i + 1];
        // Quoted delimiter only: bare `<<DELIM` allows expansion in the body.
        if (!delim || delim.kind !== 'word' || !delim.quoted) return null;
        if (heredocDelim !== null) return null; // more than one heredoc
        heredocDelim = delim.text;
        i += 2;
        continue;
      }
      if (token.text === '>' || token.text === '>>') {
        // `>>` appends — not derivable.
        if (token.text === '>>') return null;
        const targetToken = tokens[i + 1];
        if (!targetToken || targetToken.kind !== 'word' || !isStaticTarget(targetToken.text)) return null;
        if (target !== null) return null; // more than one redirect
        target = targetToken.text;
        i += 2;
        continue;
      }
      // Any other operator (pipeline, grouping, backgrounding, chaining, ...).
      return null;
    }
    // Any other token (flags, file operands, ...).
    return null;
  }
  if (heredocDelim === null || target === null) return null;

  // Heredoc body: lines up to (and excluding) the exact terminator line.
  if (rest === '') return null; // a heredoc always needs a terminator
  const lines = rest.split('\n');
  const terminatorIndex = lines.findIndex((line) => line === heredocDelim);
  if (terminatorIndex === -1) return null; // unterminated heredoc
  // Anything after the terminator would execute as a separate command (chaining).
  if (lines.slice(terminatorIndex + 1).some((line) => line.trim() !== '')) return null;

  const body = lines.slice(0, terminatorIndex);
  const content = body.length === 0 ? '' : `${body.join('\n')}\n`;
  return { target, content };
}

// ============================================================
// Shell line tokenizer (conservative, grammar-only)
// ============================================================

interface ShellToken {
  /** Unquoted value (quotes stripped; escapes resolved where static). */
  text: string;
  kind: 'word' | 'op';
  /** True when the token contained any single- or double-quoted section. */
  quoted: boolean;
}

/**
 * Lex a single shell line into words and operators.
 *
 * Deliberately conservative: anything it cannot faithfully represent either
 * fails (returns null — unterminated quotes) or emits an operator/expansion
 * marker that defeats the derivable grammar, pushing the command to the
 * opaque path.
 */
function tokenizeShellLine(line: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const c = line[i]!;
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }

    // Redirect operators: <, <<, <<-, >, >>
    if (c === '<' || c === '>') {
      let op = c;
      i += 1;
      if (i < n && line[i] === c) {
        op += c;
        i += 1;
        if (op === '<<' && i < n && line[i] === '-') {
          op += '-';
          i += 1;
        }
      }
      tokens.push({ text: op, kind: 'op', quoted: false });
      continue;
    }

    // Shell metacharacters that always defeat the derivable grammar.
    if (';&|()`'.includes(c)) {
      tokens.push({ text: c, kind: 'op', quoted: false });
      i += 1;
      continue;
    }

    // Word (possibly quoted; quotes may be mixed, e.g. foo"bar").
    let text = '';
    let quoted = false;
    while (i < n) {
      const ch = line[i]!;
      if (ch === ' ' || ch === '\t' || '<>;&|()`'.includes(ch)) break;

      if (ch === "'") {
        quoted = true;
        const close = line.indexOf("'", i + 1);
        if (close === -1) return null; // unterminated single quote
        text += line.slice(i + 1, close);
        i = close + 1;
        continue;
      }

      if (ch === '"') {
        quoted = true;
        let j = i + 1;
        let buf = '';
        let closed = false;
        while (j < n) {
          const dch = line[j];
          if (dch === '\\' && j + 1 < n && '\\"$`'.includes(line[j + 1]!)) {
            buf += line[j + 1]; // resolve escape inside double quotes
            j += 2;
            continue;
          }
          if (dch === '"') {
            closed = true;
            break;
          }
          buf += dch;
          j += 1;
        }
        if (!closed) return null; // unterminated double quote
        text += buf;
        i = j + 1;
        continue;
      }

      if (ch === '$' && line[i + 1] === '(') {
        // Command substitution marker — defeats static classification.
        text += '$( ';
        i += 2;
        continue;
      }

      if (ch === '$') {
        // Variable expansion marker — `isStaticTarget` rejects tokens with it.
        text += '$';
        i += 1;
        continue;
      }

      if (ch === '\\' && i + 1 < n) {
        text += line[i + 1]; // resolve backslash escape outside quotes
        i += 2;
        continue;
      }

      text += ch;
      i += 1;
    }
    tokens.push({ text, kind: 'word', quoted });
  }

  return tokens;
}

/**
 * A redirect target is static only if it resolves without shell expansion.
 * Expansions (`$`, backtick, `~`, `{}`) and globs (`*`, `?`, `[]`) are not
 * statically resolvable, so such commands are opaque.
 */
function isStaticTarget(target: string): boolean {
  if (target.length === 0) return false;
  if (/[\$`~{}*?\[\]]/.test(target)) return false;
  return true;
}

// ============================================================
// Opaque mutation detection
// ============================================================

/**
 * A candidate looks like a config-file path when it contains a path separator
 * (`/` or `\`), ends in `.json`/`.jsonl`, or is the validator-recognized
 * `SKILL.md` basename (e.g. `sed -i ... SKILL.md` from a skill directory).
 */
function looksPathLike(candidate: string): boolean {
  return (
    candidate.includes('/') ||
    candidate.includes('\\') ||
    /\.(json|jsonl)$/i.test(candidate) ||
    candidate === 'SKILL.md'
  );
}

// Static shell assignments collected during the opaque scan, so `$VAR`
// references resolve without executing the command. Module-level so the inner
// candidate helper stays small; reset once per scan.
const opaqueAssignments = new Map<string, string>();

/**
 * Find a recognized config target among statically identifiable opaque write
 * mutations. Returns the first recognized detection, or null.
 *
 * Combines the existing redirect extractors with a token scan that uses the
 * same static-target policy as the removed config-domain guard: any
 * quoted/unquoted token (or whitespace-separated fragment of a quoted token,
 * e.g. inside a wrapper-shell string) that looks path-like is a candidate.
 * This covers `tee`, `sed -i`, script arguments, PowerShell/CMD writes, and
 * similar forms that the redirect extractors do not model.
 *
 * Static `VAR=value` assignments are tracked so later `$VAR` / `${VAR}`
 * references (e.g. `target=labels/config.json; echo x > "$target"`) resolve
 * without executing the command.
 */
function findOpaqueRecognizedTarget(
  command: string,
  workspaceRootPath: string,
  workingDirectory?: string,
  appConfigDir?: string
): ConfigFileDetection | null {
  const candidates = new Set<string>();
  opaqueAssignments.clear();

  const bashTarget = extractBashWriteTarget(command);
  if (bashTarget) candidates.add(bashTarget);

  const psTarget = extractPowerShellWriteTarget(command);
  if (psTarget) candidates.add(psTarget);

  const tokenRegex = /'([^']+)'|"([^"]+)"|([^\s'";|&()<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!candidate) continue;

    // Quoted tokens can embed several arguments (e.g. `bash -c "sed -i 's/x/y/'
    // labels/config.json"`); examine each whitespace-separated fragment so
    // path-like parts are candidates individually.
    for (const part of candidate.split(/\s+/)) {
      if (part.length === 0) continue;
      classifyOpaqueCandidate(part, candidates);
    }
  }

  for (const candidate of candidates) {
    const detection = detectForTarget(candidate, workspaceRootPath, workingDirectory, appConfigDir);
    if (detection) return detection;
  }
  return null;
}

/**
 * Classify a single opaque-scan token as a potential config-write target.
 *
 * - `VAR=value` with a static value: remember the assignment and treat the
 *   value as a candidate (it may be the config path being written).
 * - Pure `$VAR` / `${VAR}` references: resolve from earlier assignments.
 * - Path-like fragments with embedded `$VAR` (e.g. `$dir/config.json`): add
 *   the expanded form.
 * - Otherwise, path-like tokens are candidates directly.
 */
function classifyOpaqueCandidate(candidate: string, candidates: Set<string>): void {
  // Static assignment — record it for reference resolution below.
  const assignMatch = candidate.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (assignMatch) {
    const value = assignMatch[2] ?? '';
    if (value.length > 0 && isStaticTarget(value)) {
      opaqueAssignments.set(assignMatch[1]!, value);
      if (looksPathLike(value)) candidates.add(value);
    }
    return;
  }

  // Pure `$VAR` / `${VAR}` reference — resolve from an earlier assignment.
  const braceRef = candidate.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braceRef) {
    const value = opaqueAssignments.get(braceRef[1]!);
    if (value) candidates.add(value);
    return;
  }
  const simpleRef = candidate.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (simpleRef) {
    const value = opaqueAssignments.get(simpleRef[1]!);
    if (value) candidates.add(value);
    return;
  }

  // Embedded `$VAR` inside a path (e.g. `$dir/config.json` after
  // `dir=labels`) — expand and re-check.
  const expanded = candidate.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_whole, name: string) =>
    opaqueAssignments.get(name) ?? `$${name}`
  );
  if (expanded !== candidate) {
    if (looksPathLike(expanded)) candidates.add(expanded);
    return;
  }

  if (looksPathLike(candidate)) candidates.add(candidate);
}

/**
 * Resolve a (possibly relative) target and detect whether it is a
 * validator-recognized config file (workspace-scoped first, then app-level).
 */
function detectForTarget(
  target: string,
  workspaceRootPath: string,
  workingDirectory?: string,
  appConfigDir?: string
): ConfigFileDetection | null {
  const resolved = resolveTarget(target, workspaceRootPath, workingDirectory);
  return detectConfigFileType(resolved, workspaceRootPath) ?? detectAppConfigFileType(resolved, appConfigDir);
}

function resolveTarget(target: string, workspaceRootPath: string, workingDirectory?: string): string {
  const base = workingDirectory && workingDirectory.length > 0 ? workingDirectory : workspaceRootPath;
  return resolve(base, target);
}

// ============================================================
// Block message
// ============================================================

function buildOpaqueBlockReason(detection: ConfigFileDetection): string {
  return (
    `Bash command targeting \`${detection.displayFile}\` could not be proven read-only, so it is blocked ` +
    `because it could bypass config validation.\n\n` +
    `Use the validated \`Write\` or \`Edit\` tool to update this file, or an applicable ` +
    `configuration tool (e.g. \`kata-agents-cli invoke ...\`) when one exists. ` +
    `Read-only commands allowed by your permissions (\`permissions/default.json\`) continue to work.`
  );
}
