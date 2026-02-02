# Feature Landscape: Git Status UI

**Domain:** Developer tool git integration (branch/PR display)
**Researched:** 2026-02-02
**Confidence:** HIGH (based on official documentation from VS Code, GitHub Desktop, JetBrains)

## Table Stakes

Features users expect from git status display in developer tools. Missing = feels broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Current branch name** | Every major IDE shows this. VS Code, JetBrains, GitHub Desktop all display prominently. Users need to know "where am I?" | Low | VS Code: bottom-left status bar. JetBrains: moved to toolbar in new UI. GitHub Desktop: "Current Branch" button. |
| **Branch display location** | Must be visible without interaction. Status bar or header is standard. | Low | JetBrains users complained when branch was removed from status bar (IDEA-308917). Visibility matters. |
| **Click-to-copy branch name** | Common developer workflow: copy branch name for PR titles, Jira tickets, Slack. | Low | Not always explicit, but expected. Single click or hover-copy. |
| **Linked PR display (when exists)** | GitLens, GitHub Desktop 3.0+, and VS Code GitHub extension all show this. Developer expectation is growing. | Medium | GitHub Desktop: badge with PR number, click opens checks. GitLens: PR icon on branches, "linked PRs or issues when available." |
| **PR status indicator** | Pass/fail/pending badge. GitHub Desktop 3.0 added real-time check status display. | Medium | Green check, yellow pending, red X. Universal convention. |

### Evidence for Table Stakes

**Branch Name Display:**
- VS Code: "You can find indicators of the status of your repository in the bottom left corner of VS Code: the current branch, dirty indicators and the number of incoming and outgoing commits" ([VS Code Docs](https://code.visualstudio.com/docs/sourcecontrol/overview))
- JetBrains: "The widget shows the current branch, allows switching branches, and provides the most popular VCS actions" ([IntelliJ New UI](https://www.jetbrains.com/help/idea/new-ui.html))
- GitHub Desktop: Branch shown in prominent "Current Branch" button at top of window

**Linked PR Display:**
- GitHub Desktop 3.0: "You can now see the checks of your pull requests to ensure your code is ready for production" ([GitHub Blog](https://github.blog/2022-04-26-github-desktop-3-0-brings-better-integration-for-your-pull-requests/))
- GitLens: "Shows linked PRs or issues when available, or offers to start a new PR" ([GitLens Docs](https://help.gitkraken.com/gitlens/side-bar/))

## Differentiators

Features that would make Kata Agents' git display better than typical. Not expected, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **PR title inline** | Most tools show PR number only, requiring click to see title. Showing title inline gives instant context. | Low | GitHub Desktop shows PR list with titles, but not inline in main view. Opportunity. |
| **AI context awareness** | Agent knows git context automatically. "I see you're on feature/user-auth with PR #42 open" - no need to explain. | Medium | Unique to AI-native tools. Context injection into agent prompts. |
| **PR review status** | Show "Approved", "Changes requested", or "Waiting for review" at a glance. | Medium | GitHub Desktop 3.0 added review notifications but not persistent status display. |
| **Dirty indicator** | Show uncommitted changes exist (red dot or asterisk next to branch). | Low | VS Code shows "dirty indicators" in status bar. Common but not universal in simpler tools. |
| **Ahead/behind count** | Show "2 ahead, 1 behind" sync status with remote. | Medium | VS Code and JetBrains show this. Useful but adds visual complexity. |
| **One-click PR open** | Click PR badge opens PR in browser. Zero friction. | Low | GitHub Desktop has this. GitLens has "Open Associated Pull Request" command. |

### Value Analysis

**AI Context Awareness** is the strongest differentiator. No existing tool automatically injects git context into AI conversations. This turns passive display into active assistance:
- Agent sees branch name suggests relevant code areas
- Agent sees PR title understands current task
- Agent sees PR status can suggest next actions ("PR approved, ready to merge")

## Anti-Features

Things to deliberately NOT build for v0.6.0. Common mistakes in this domain.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Branch switching UI** | Scope creep. Kata Agents is an AI chat tool, not a Git client. VS Code, Tower, GitKraken already do this well. | Display only. Users switch branches in their IDE or terminal. |
| **Commit history view** | Major feature, not needed for context display. GitHub Desktop has full commit graph. | Show current state only. History is visible in existing tools. |
| **Diff viewer** | VS Code has excellent built-in diff. Duplicating this is wasteful. | Link to PR on GitHub where diffs are viewable. |
| **Merge/rebase controls** | Complex operations that can destroy work. "Git Tools can make mistakes even easier" ([DZone](https://dzone.com/refcardz/git-patterns-and-anti-patterns)). | Not even a link. Users handle merges in dedicated tools. |
| **Full PR details panel** | Comments, reviewers, files changed - this is GitHub's job. | Show title + status badge. Link to GitHub for details. |
| **Branch creation** | Workflow complexity. Users have established branch creation flows. | Display current branch. Creation happens elsewhere. |
| **Stash management** | Complex feature, niche use case, easy to cause data loss. | Out of scope entirely. |
| **Multiple remote support** | Edge case complexity. Most users have one remote (origin). | Assume single remote for v0.6.0. |
| **Sync status polling** | Frequent git operations can slow large repos. "git status" can be expensive. | Fetch on workspace open, manual refresh. No auto-polling. |

### Anti-Pattern Evidence

**"Button Addict" Anti-Pattern:** One presentation identifies adding too many Git GUI controls as an anti-pattern. "DON'T underestimate the complexity and danger of Git" ([Speaker Deck](https://speakerdeck.com/lemiorhan/10-git-anti-patterns-you-should-be-aware-of)).

**Complexity Trap:** "Building unnecessarily complex solutions or adding features without clear value... Increases complexity and potential for bugs" ([BairesDev](https://www.bairesdev.com/blog/software-anti-patterns/)).

## Feature Dependencies

```
Branch Name Display (prerequisite for all)
    |
    +-- Linked PR Display (requires knowing current branch to query GitHub)
    |       |
    |       +-- PR Status Badge (requires PR data)
    |       |
    |       +-- PR Title Display (requires PR data)
    |
    +-- Dirty Indicator (independent git status check)
```

**Key Dependency:** PR features require GitHub API integration (`gh` CLI or GitHub REST API). Branch display is git-only.

## MVP Recommendation

For v0.6.0, prioritize:

1. **Branch name display** - Table stakes, low complexity, immediate value
2. **Linked PR title + status** - Differentiator when combined with AI context, medium complexity
3. **Click to open PR** - Low complexity, high convenience

**Implementation approach:**
- Display branch name in workspace header (near WorkspaceSwitcher)
- When PR exists: Show "[PR #42] Fix user auth - Passing"
- Click opens PR in browser
- Inject git context into agent system prompt

Defer to post-MVP (v0.7.0+):
- Dirty indicator: Requires ongoing git status monitoring, adds complexity
- Ahead/behind count: Requires remote tracking, additional API calls
- PR review status: Requires additional GitHub API calls

## UI Placement Patterns (Industry Standard)

| Tool | Branch Location | PR Location |
|------|-----------------|-------------|
| VS Code | Bottom-left status bar | Source Control sidebar (GitLens adds status bar) |
| JetBrains (New UI) | Top toolbar widget | Git tool window |
| GitHub Desktop | Top "Current Branch" button | Pull Requests tab in branch dropdown |
| GitLens | Status bar + sidebar | Sidebar "Linked PRs" section |

**Recommendation for Kata Agents:**
- Branch + PR in workspace header area (consistent with WorkspaceSwitcher pattern)
- Small, unobtrusive badge/text near workspace name
- Follows pattern of "workspace context" information in one location

## Sources

**Official Documentation (HIGH confidence):**
- [VS Code Source Control Overview](https://code.visualstudio.com/docs/sourcecontrol/overview)
- [GitHub Desktop PR Viewing](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/viewing-a-pull-request-in-github-desktop)
- [JetBrains IntelliJ New UI](https://www.jetbrains.com/help/idea/new-ui.html)
- [GitLens Side Bar Views](https://help.gitkraken.com/gitlens/side-bar/)

**Release Announcements (MEDIUM confidence):**
- [GitHub Desktop 3.0 PR Integration](https://github.blog/2022-04-26-github-desktop-3-0-brings-better-integration-for-your-pull-requests/)
- [GitHub Desktop 3.2 PR Preview](https://github.blog/2023-03-03-github-desktop-3-2-preview-your-pull-request/)

**Community/Best Practices (MEDIUM confidence):**
- [Git Patterns and Anti-Patterns - DZone](https://dzone.com/refcardz/git-patterns-and-anti-patterns)
- [LazyGit UX Analysis](https://www.bwplotka.dev/2025/lazygit/)
- [JetBrains User Feedback on Branch Widget](https://youtrack.jetbrains.com/issue/IDEA-308917)
