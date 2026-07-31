import * as React from 'react'
import type {
  GitFileDiff,
  GitStatusSnapshot,
  Session,
  WorktreeRemovalRisk,
} from '@kata-sh/shared/protocol'
import { appStore } from '@/atoms/store'
import { sessionAtomFamily } from '@/atoms/sessions'
import { WorkspaceCheckoutBadge } from '@/components/app-shell/input/WorkspaceCheckoutBadge'
import { DeleteSessionDialog } from '@/components/app-shell/DeleteSessionDialog'
import { FreeFormInput } from '@/components/app-shell/input/FreeFormInput'
import { ChangesAffordance } from '@/components/right-sidebar/git-changes/ChangesAffordance'
import { ChangesPanel } from '@/components/right-sidebar/git-changes/ChangesPanel'
import { GitActionControl } from '@/components/right-sidebar/git-changes/GitActionControl'
import { ModalProvider } from '@/context/ModalContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import type { ComponentEntry } from './types'

const SESSION_ID = 'git-workspace-validation'
const WORKTREE_PATH = '/workspace/kata-agents/.worktrees/7ac42f19'

globalThis.__KATA_FEATURE_FLAGS__ = {
  ...globalThis.__KATA_FEATURE_FLAGS__,
  KATA_FEATURE_GIT_WORKSPACE_V1: '1',
}

const session: Session = {
  id: SESSION_ID,
  workspaceId: 'playground-workspace',
  workspaceName: 'Playground',
  name: 'Finish managed worktree lifecycle',
  lastMessageAt: Date.now(),
  messages: [],
  isProcessing: false,
  workingDirectory: WORKTREE_PATH,
  checkout: {
    schemaVersion: 1,
    mode: 'managed-worktree',
    repositoryRoot: '/workspace/kata-agents',
    checkoutPath: WORKTREE_PATH,
    branchAtPreparation: 'kata-agent/7ac42f19',
    baseRef: 'main',
    managedWorktreeId: '7ac42f19',
    expectedBranch: 'kata-agent/7ac42f19',
  },
  sharedOwnerCount: 1,
}

const status: GitStatusSnapshot = {
  repositoryRoot: '/workspace/kata-agents',
  checkoutPath: WORKTREE_PATH,
  isGitRepository: true,
  currentBranch: 'kata-agent/7ac42f19',
  detached: false,
  defaultRef: 'main',
  baseRef: 'main',
  upstream: null,
  ahead: 0,
  behind: 0,
  publishableCommitCount: 1,
  baseDeltaCount: 1,
  latestCommitSubject: 'feat(git): finish managed worktree lifecycle',
  pullRequestTemplate: '## Summary\n\n- Describe the completed workflow\n\n## Validation\n\n- [ ] Tests pass',
  primaryRemote: 'origin',
  provider: 'github',
  entries: [
    {
      path: 'apps/electron/src/renderer/components/GitWorkspace.tsx',
      type: 'modified',
      indexState: '.',
      worktreeState: 'M',
      additions: 24,
      deletions: 6,
    },
    {
      path: 'e2e/tests/git/managed-worktree.spec.ts',
      type: 'added',
      indexState: 'A',
      worktreeState: '.',
      additions: 118,
      deletions: 0,
    },
  ],
  additions: 142,
  deletions: 6,
  operationInProgress: null,
  blockedReason: null,
}

const diff: GitFileDiff = {
  path: 'apps/electron/src/renderer/components/GitWorkspace.tsx',
  changeType: 'modified',
  state: 'text',
  oldContent:
    "export function GitWorkspace() {\n  return <div>Current checkout</div>\n}\n",
  newContent:
    "export function GitWorkspace() {\n  const checkout = useManagedWorktree()\n  return <WorkspaceIdentity checkout={checkout} />\n}\n",
  additions: 2,
  deletions: 1,
  sizeBytes: 172,
  fingerprint: 'playground-git-workspace-diff',
  language: 'tsx',
}

const removalRisk: WorktreeRemovalRisk = {
  managedWorktreeId: '7ac42f19',
  exists: true,
  ownerSessionIds: [SESSION_ID],
  otherOwnerCount: 0,
  uncommittedFileCount: 2,
  unpushedCommitCount: 1,
  branchHasUniqueWork: true,
  confirmationFingerprint: 'playground-removal-confirmation',
  blocked: false,
}

appStore.set(sessionAtomFamily(SESSION_ID), session)

Object.assign(window.electronAPI, {
  // Branch identity is per-checkout: the managed worktree is on its own
  // `kata-agent/…` branch while the source checkout is on `main`. Reporting
  // `main` for both would make the composer's drift guard fire on the bound
  // session, which is a fixture artifact rather than real behavior.
  getGitContext: async (dir?: string) => ({
    isGitRepository: true,
    repositoryRoot: '/workspace/kata-agents',
    gitCommonDir: '/workspace/kata-agents/.git',
    currentBranch: dir === WORKTREE_PATH ? 'kata-agent/7ac42f19' : 'main',
    detached: false,
    headSha: '0'.repeat(40),
    defaultRef: 'main',
    remotes: [
      {
        name: 'origin',
        fetchUrl: 'https://github.com/gannonh/kata-agents.git',
        pushUrl: 'https://github.com/gannonh/kata-agents.git',
        provider: 'github',
      },
    ],
    primaryRemote: 'origin',
    provider: 'github',
  }),
  listGitRefs: async () => ({
    currentBranch: 'main',
    defaultRef: 'main',
    refs: [
      {
        name: 'main',
        fullName: 'refs/heads/main',
        type: 'local',
        sha: '0'.repeat(40),
        isCurrent: true,
      },
      {
        name: 'origin/main',
        fullName: 'refs/remotes/origin/main',
        type: 'remote',
        sha: '0'.repeat(40),
      },
    ],
  }),
  subscribeGitStatus: async () => status,
  unsubscribeGitStatus: async () => {},
  onGitStatusChanged: () => () => {},
  getGitDiff: async () => diff,
  getGitHubCapability: async () => ({
    installed: false,
    authenticated: false,
    detail: 'Install GitHub CLI to create or view pull requests.',
  }),
  getPullRequest: async () => null,
  inspectGitWorktreeRemoval: async () => removalRisk,
  removeGitWorktree: async () => ({
    removed: true,
    branchPruned: false,
    blocked: false,
  }),
})

// An unbound sibling session, for the side-by-side directory-lock comparison.
const UNBOUND_SESSION_ID = 'git-workspace-unbound'
const unboundSession: Session = {
  ...session,
  id: UNBOUND_SESSION_ID,
  name: 'No checkout prepared yet',
  workingDirectory: '/workspace/kata-agents',
  checkout: undefined,
  sharedOwnerCount: undefined,
}
appStore.set(sessionAtomFamily(UNBOUND_SESSION_ID), unboundSession)

type ValidationView = 'start' | 'review' | 'share' | 'remove' | 'directory-lock'

function GitWorkspaceValidation({ view }: { view: ValidationView }) {
  if (view === 'start') {
    return (
      <div className="flex h-full items-center justify-center bg-muted/20 p-10">
        <div className="w-full max-w-[620px] rounded-xl border border-border bg-background p-5 shadow-sm">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            New agent session
          </p>
          <div className="rounded-lg border border-border/70 p-4">
            <p className="mb-4 text-sm text-muted-foreground">
              Choose the checkout before the first message. New worktree preparation is gated before
              Send.
            </p>
            <WorkspaceCheckoutBadge
              sessionId="git-workspace-empty-session"
              workingDirectory="/workspace/kata-agents"
              isEmptySession
              onWorkingDirectoryChange={() => {}}
            />
          </div>
        </div>
      </div>
    )
  }

  if (view === 'review') {
    return (
      <div className="h-full bg-background">
        <ChangesPanel sessionId={SESSION_ID} />
      </div>
    )
  }

  if (view === 'share') {
    return (
      <div className="flex h-full flex-col bg-muted/20 p-8">
        <div className="mx-auto flex w-full max-w-[760px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Finish managed worktree lifecycle</p>
              <p className="text-xs text-muted-foreground">kata-agent/7ac42f19 · 2 changed files</p>
            </div>
            <div className="flex items-center gap-2">
              <ChangesAffordance sessionId={SESSION_ID} />
              <GitActionControl sessionId={SESSION_ID} />
            </div>
          </div>
          <div className="grid flex-1 place-items-center p-12 text-center">
            <div>
              <p className="text-sm font-medium">Changes are ready to share</p>
              <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                Commit and push remain available. GitHub-specific actions explain the missing
                workspace-owner dependency without changing repository state.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'directory-lock') {
    // Two real composers. The unbound session can still pick a directory; the
    // session bound to a managed worktree cannot — the checkout owns where it
    // works, and the server rejects working-directory changes for it.
    return (
      <div className="flex h-full flex-col gap-6 overflow-auto bg-muted/20 p-8">
        <div className="mx-auto w-full max-w-[760px]">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            No checkout bound — directory is selectable
          </p>
          <div className="rounded-xl border border-border bg-background p-3 shadow-sm">
            <FreeFormInput
              sessionId={UNBOUND_SESSION_ID}
              placeholder="Ask anything…"
              currentModel="claude-sonnet-4-20250514"
              onModelChange={() => {}}
              permissionMode="ask"
              onPermissionModeChange={() => {}}
              inputValue=""
              onInputChange={() => {}}
              workingDirectory="/workspace/kata-agents"
              onWorkingDirectoryChange={() => {}}
              onSubmit={() => {}}
              onStop={() => {}}
            />
          </div>
        </div>

        <div className="mx-auto w-full max-w-[760px]">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Managed worktree bound — directory selector withdrawn
          </p>
          <div className="rounded-xl border border-border bg-background p-3 shadow-sm">
            <FreeFormInput
              sessionId={SESSION_ID}
              placeholder="Ask anything…"
              currentModel="claude-sonnet-4-20250514"
              onModelChange={() => {}}
              permissionMode="ask"
              onPermissionModeChange={() => {}}
              inputValue=""
              onInputChange={() => {}}
              workingDirectory={WORKTREE_PATH}
              onWorkingDirectoryChange={() => {}}
              onSubmit={() => {}}
              onStop={() => {}}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full place-items-center bg-muted/20">
      <DeleteSessionDialog
        open
        sessionId={SESSION_ID}
        sessionName="Finish managed worktree lifecycle"
        branch="kata-agent/7ac42f19"
        onOpenChange={() => {}}
        onDeleteSession={async () => ({ deleted: true })}
      />
    </div>
  )
}

function GitWorkspaceValidationWrapper({ children }: { children: React.ReactNode }) {
  return (
    <ModalProvider>
      <NavigationProvider
        workspaceId="playground-workspace"
        workspaceSlug="playground"
        onCreateSession={async () => session}
      >
        {children}
      </NavigationProvider>
    </ModalProvider>
  )
}

export const gitWorkspaceComponents: ComponentEntry[] = [
  {
    id: 'git-workspace-validation',
    name: 'Git Workspace acceptance',
    category: 'Git Workspace',
    description: 'Production Git workspace surfaces used for acceptance evidence',
    component: GitWorkspaceValidation,
    wrapper: GitWorkspaceValidationWrapper,
    layout: 'full',
    props: [
      {
        name: 'view',
        description: 'Vertical slice to inspect',
        control: {
          type: 'select',
          options: [
            { label: 'Start isolated', value: 'start' },
            { label: 'Review changes', value: 'review' },
            { label: 'Share work', value: 'share' },
            { label: 'Manage lifecycle', value: 'remove' },
            { label: 'Checkout directory lock', value: 'directory-lock' },
          ],
        },
        defaultValue: 'review',
      },
    ],
    variants: [
      { name: 'Start isolated', props: { view: 'start' } },
      { name: 'Review changes', props: { view: 'review' } },
      { name: 'Share work', props: { view: 'share' } },
      { name: 'Manage lifecycle', props: { view: 'remove' } },
      { name: 'Checkout directory lock', props: { view: 'directory-lock' } },
    ],
  },
]
