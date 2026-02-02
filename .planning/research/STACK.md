# Technology Stack

**Project:** Kata Agents v0.6.0 - Git Status UI Integration
**Researched:** 2026-02-02

## Recommended Stack

### Git Operations

| Technology  | Version  | Purpose                                         | Why                                                                                                                    |
| ----------- | -------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| simple-git  | ^3.30.0  | Read git status, branch, tracking info          | 8.5M weekly downloads, actively maintained, wraps git CLI (already on user systems), full TypeScript support, returns structured StatusResult |

### GitHub API Access (for PR info)

| Technology | Version | Purpose                      | Why                                                                                                       |
| ---------- | ------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| gh CLI     | N/A     | Get PR info for current branch | Zero dependencies to add, user already authenticated, JSON output, app already handles shell environment loading |

**NOT recommending @octokit/rest because:**
1. Requires additional auth flow (OAuth device flow or token management)
2. gh CLI is already authenticated on developer machines
3. App already has shell-env.ts that loads PATH including `/opt/homebrew/bin` where gh lives
4. Simpler: `gh pr list --head branch --json` vs OAuth setup + API calls

### Supporting Libraries

| Library | Version | Purpose              | When to Use                              |
| ------- | ------- | -------------------- | ---------------------------------------- |
| None    | -       | -                    | No additional libraries needed           |

## Detailed Rationale

### Why simple-git (not isomorphic-git or nodegit)

**simple-git selected because:**
- **CLI wrapper approach fits Electron** - Users already have git installed; no need for pure JS reimplementation
- **8.5M weekly downloads** - Ecosystem standard, well-tested
- **StatusResult interface gives us everything we need:**
  - `current`: Current branch name
  - `tracking`: Upstream branch (e.g., `origin/main`)
  - `ahead`: Commits ahead of tracked branch
  - `behind`: Commits behind tracked branch
  - `detached`: Boolean for detached HEAD state
- **TypeScript-first** - Bundled types since v3.x, ESM/CommonJS/TS support

**Alternatives rejected:**

| Alternative     | Why Not                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| isomorphic-git  | Pure JS reimplementation - slower for large repos, more complex API, overkill for reading status |
| nodegit         | Native libgit2 bindings - compile issues with Electron, rebuild complexity           |
| Raw git CLI     | Would work but simple-git already parses porcelain output into typed objects         |

### Why gh CLI (not @octokit/rest)

The project already has `apps/electron/src/main/shell-env.ts` which:
- Loads user's full shell environment on macOS
- Ensures `/opt/homebrew/bin` (where gh lives) is in PATH
- Already handles the "GUI app has minimal environment" problem

**Using gh CLI:**
```typescript
// Get PR for current branch
const result = execSync('gh pr list --head branch-name --json number,title,state,url', {
  encoding: 'utf-8',
  cwd: workspacePath
});
const prs = JSON.parse(result);
```

**Available JSON fields for PRs:**
- `number`, `title`, `state`, `url`
- `author`, `baseRefName`, `headRefName`
- `isDraft`, `mergeable`, `reviewDecision`
- `statusCheckRollup` (CI status)

**Why not @octokit/rest:**

| Concern            | gh CLI                                  | @octokit/rest                                      |
| ------------------ | --------------------------------------- | -------------------------------------------------- |
| Authentication     | Already done (user ran `gh auth login`) | Need device flow or token storage                  |
| Dependencies       | Zero (already on dev machines)          | +@octokit/rest, potentially auth plugins           |
| Maintenance burden | Shell already handles PATH              | OAuth flow, token refresh, error handling          |
| User experience    | Works if gh works                       | Need to prompt for GitHub auth in app              |

**Fallback strategy:** If `gh` is not installed or not authenticated, gracefully degrade - show git branch info but indicate "GitHub CLI not available for PR info."

## Installation

```bash
# Only one new dependency needed
bun add simple-git
```

No changes to devDependencies required.

## Integration Pattern

### Main Process Only

Both simple-git and gh CLI should run in the **main process** (not renderer):
- simple-git wraps git CLI - needs filesystem access
- gh CLI is a subprocess - needs shell environment
- App already uses this pattern for agent subprocess spawning

### Recommended Module Location

```
packages/shared/src/git/
  index.ts          # Public exports
  git-status.ts     # simple-git wrapper for status/branch
  github-pr.ts      # gh CLI wrapper for PR info
  types.ts          # GitContext interface
```

### GitContext Interface

```typescript
interface GitContext {
  // From simple-git status()
  branch: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;

  // From gh CLI (optional - may not be available)
  pullRequest?: {
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    url: string;
    isDraft: boolean;
  };

  // Meta
  hasGit: boolean;
  hasGhCli: boolean;
}
```

## What NOT to Add

| Library/Tool           | Why Not                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| @octokit/rest          | Auth complexity, gh CLI already handles this                      |
| @octokit/oauth-device  | Not needed if using gh CLI                                        |
| isomorphic-git         | Overkill, slower, more complex for read-only operations           |
| nodegit                | Native module complexity with Electron packaging                  |
| dugite                 | Bundles git binary - unnecessary, users have git                  |
| git-status npm         | Abandoned, simple-git is the standard                             |
| any git hosting UI     | Out of scope - just showing context, not managing                 |

## Version Verification

| Package    | Verified Version | Source                                                                                     | Confidence |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------ | ---------- |
| simple-git | 3.30.0           | [npm registry](https://www.npmjs.com/package/simple-git) (published 2 months ago)          | HIGH       |
| gh CLI     | N/A (external)   | [GitHub CLI docs](https://cli.github.com/manual/gh_pr_view)                                | HIGH       |

## Sources

- [simple-git npm](https://www.npmjs.com/package/simple-git) - Version and download stats
- [steveukx/git-js GitHub](https://github.com/steveukx/git-js) - TypeScript types and API
- [npm-compare: simple-git vs isomorphic-git vs nodegit](https://npm-compare.com/isomorphic-git,nodegit,simple-git) - Library comparison
- [gh pr view documentation](https://cli.github.com/manual/gh_pr_view) - JSON fields and syntax
- [gh pr list documentation](https://cli.github.com/manual/gh_pr_list) - Filtering by branch
- Existing codebase: `apps/electron/src/main/shell-env.ts` - Shell environment handling
