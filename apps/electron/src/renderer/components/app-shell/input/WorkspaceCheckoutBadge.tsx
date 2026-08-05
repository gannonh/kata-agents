import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { Command as CommandPrimitive } from 'cmdk'
import { AlertTriangle, Check, FolderGit2, GitBranch, GitFork, Loader2, Users } from 'lucide-react'

import { FEATURE_FLAGS } from '@kata-sh/shared/feature-flags'
import type {
  CheckoutMode,
  CheckoutPrepareResultVersioned,
  GitRef,
  ManagedWorktreeSummaryVersioned,
} from '@kata-sh/shared/protocol'

import { sessionAtomFamily, updateSessionAtom } from '@/atoms/sessions'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import {
  resolveCheckoutIdentity,
  generateDefaultWorktreeName,
  normalizeWorktreeName,
  normalizeWorktreeNameInput,
  resolveCheckoutRecovery,
  resolveLiveBranchLabel,
  resolveSendGate,
} from './checkout-controls'
import {
  getGitContextRefreshKey,
  getLiveGitContext,
  refreshGitContext,
  type GitContextRefreshState,
} from './git-context'

/**
 * WorkspaceCheckoutBadge — composer Workspace control for Git checkouts.
 *
 * Feature-flag gated by {@link FEATURE_FLAGS.gitWorkspaceV1}. Before the first
 * message in a Git repository it offers a Workspace menu with **Current
 * checkout**, **New worktree**, and **Existing worktree**; New worktree
 * reveals a searchable **From `<ref>`** picker defaulting to the current
 * branch, while Existing worktree lists the workspace's ready managed
 * worktrees for this repository so a new session can share one.
 *
 * A selected New worktree/ref intent stays renderer state until it is prepared.
 * Preparation happens on the workspace-owning server via `prepareGitCheckout`
 * and is triggered on the first Send through the imperative
 * {@link WorkspaceCheckoutHandle.prepareIfNeeded} so a message can never bypass
 * preparation and land in the Current checkout (AC4). On success the controls
 * lock and show the checkout identity even if the subsequent message send fails.
 *
 * Identity for a resumed/restarted session is derived from the persisted
 * `session.checkout` (+ derived `sharedOwnerCount`) so it never resets to
 * Current (AC5), and a worktree shared by more than one owner shows the
 * **Shared worktree** label (AC8).
 */
export interface WorkspaceCheckoutBadgeProps {
  sessionId?: string
  workingDirectory?: string
  isEmptySession?: boolean
  onWorkingDirectoryChange: (path: string) => void
  /** Notified once a checkout is prepared and the controls lock. */
  onCheckoutPrepared?: (result: CheckoutPrepareResultVersioned) => void
}

/** Result of a prepare-before-send attempt. */
export interface PrepareOutcome {
  status: 'ready' | 'not-needed' | 'error'
  error?: string
}

/** Imperative handle used by the FreeFormInput submit path (AC4). */
export interface WorkspaceCheckoutHandle {
  /**
   * Ensure any pending New worktree/ref intent is prepared before the message
   * is accepted. Returns `not-needed` when the current selection can send
   * directly, `ready` after a successful preparation, or `error` (with a
   * message) when preparation is required but failed — in which case the caller
   * must NOT send the message.
   */
  prepareIfNeeded(): Promise<PrepareOutcome>
}

const MENU_CONTAINER_STYLE =
  'min-w-[220px] max-w-[380px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0'
const MENU_LIST_STYLE = 'max-h-[220px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
const MENU_ITEM_STYLE =
  'flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] outline-none data-[selected=true]:bg-foreground/5'

/** Deduplicate refs by display name, keeping the first (local-branch) entry. */
function dedupeRefs(refs: GitRef[]): GitRef[] {
  const seen = new Set<string>()
  const out: GitRef[] = []
  for (const ref of refs) {
    if (seen.has(ref.name)) continue
    seen.add(ref.name)
    out.push(ref)
  }
  return out
}

/** Visible identity of a managed worktree summary: the V2 display name when present. */
function worktreeDisplayLabel(worktree: ManagedWorktreeSummaryVersioned): string {
  return 'displayName' in worktree ? worktree.displayName : worktree.expectedBranch
}

function WorkspaceCheckoutBadgeInner(
  {
    sessionId,
    workingDirectory,
    isEmptySession = false,
    onWorkingDirectoryChange,
    onCheckoutPrepared,
  }: WorkspaceCheckoutBadgeProps,
  ref: React.ForwardedRef<WorkspaceCheckoutHandle>,
) {
  const { t } = useTranslation()
  const flagEnabled = FEATURE_FLAGS.gitWorkspaceV1
  const isFocusedPanel = useOptionalAppShellContext()?.isFocusedPanel ?? true
  const [contextRefreshToken, setContextRefreshToken] = React.useState(0)
  const contextRequestKey = getGitContextRefreshKey({
    flagEnabled,
    workingDirectory,
    sessionId,
    isFocusedPanel,
    refreshToken: contextRefreshToken,
  })
  const [contextState, setContextState] = React.useState<GitContextRefreshState>(() => ({
    requestKey: contextRequestKey,
    context: null,
    status: flagEnabled && !!workingDirectory ? 'loading' : 'disabled',
  }))
  // A session or panel-focus switch can render once before the refresh effect
  // runs. Keying the state prevents that render from exposing the previous
  // session's branch, and the explicit status keeps a pending request distinct
  // from a confirmed non-Git directory.
  const contextMatchesRequest = contextState.requestKey === contextRequestKey
  const contextReady = contextMatchesRequest && contextState.status === 'ready'
  const context = contextMatchesRequest ? contextState.context : null
  const [mode, setMode] = React.useState<CheckoutMode>('current')
  const [serverV2Available, setServerV2Available] = React.useState(false)
  const [serverV2Pending, setServerV2Pending] = React.useState(true)
  // V2 is governed by the workspace-owning server, not by the local renderer
  // environment (see the capability effect below).
  const worktreeV2Enabled = serverV2Available
  const modeRef = React.useRef(mode)
  modeRef.current = mode
  const [intentKind, setIntentKind] = React.useState<'new' | 'existing'>('new')
  const [baseRef, setBaseRef] = React.useState<string | null>(null)
  const [worktreeNameSuffix, setWorktreeNameSuffix] = React.useState<string | null>(null)
  const [selectedWorktreeId, setSelectedWorktreeId] = React.useState<string | null>(null)
  const [worktrees, setWorktrees] = React.useState<ManagedWorktreeSummaryVersioned[]>([])
  const [worktreesLoading, setWorktreesLoading] = React.useState(false)
  const [refs, setRefs] = React.useState<GitRef[]>([])
  const [refsLoading, setRefsLoading] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [preparing, setPreparing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [preparedState, setPreparedState] = React.useState<{
    sessionId?: string
    result: CheckoutPrepareResultVersioned | null
  }>(() => ({ sessionId, result: null }))
  // A prepared checkout belongs to one session. Do not let a reused badge carry
  // its local identity into a newly selected session before the cleanup effect.
  const prepared = preparedState.sessionId === sessionId ? preparedState.result : null

  // Persisted checkout + shared-owner count from the session DTO. Present after
  // preparation and on resume/restart — this is what keeps a resumed session
  // locked to its worktree/shared identity instead of resetting to Current.
  const session = useAtomValue(sessionAtomFamily(sessionId ?? '__no_session__'))
  const updateSession = useSetAtom(updateSessionAtom)
  const persistedCheckout = session?.checkout ?? null
  const sharedOwnerCount = session?.sharedOwnerCount

  // Discover the effective capability from the workspace-owning server. V2 is
  // governed by the owning server's feature flag, not by the local renderer
  // environment: a remote/headless server with Worktree V2 enabled drives the
  // V2 controls even when the desktop client did not set the flag, while a
  // V1-only server retains the V1 intent shape.
  React.useEffect(() => {
    let cancelled = false
    window.electronAPI
      ?.getGitCapabilities?.()
      .then((capability) => {
        if (cancelled) return
        const available = !!capability?.worktreeV2
        setServerV2Available(available)
        setServerV2Pending(false)
        if (available) {
          setWorktreeNameSuffix((previous) => previous ?? generateDefaultWorktreeName())
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerV2Available(false)
          setServerV2Pending(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, workingDirectory, isFocusedPanel])

  // Reset transient selection state when the active session or directory
  // changes. Panel focus changes deliberately preserve a pending New worktree
  // intent while still triggering fresh Git discovery below. The V2 default
  // name is seeded when the owning server's capability resolves.
  React.useEffect(() => {
    setMode('current')
    setIntentKind('new')
    setBaseRef(null)
    setWorktreeNameSuffix(null)
    setServerV2Pending(true)
    setSelectedWorktreeId(null)
    setWorktrees([])
    setWorktreesLoading(false)
    setRefs([])
    setRefsLoading(false)
    setError(null)
  }, [flagEnabled, workingDirectory, sessionId])

  // Resolve repository identity for the active session, directory, and panel.
  // The session ID prevents stale results across session selection; panel focus
  // ensures an already-mounted panel refreshes when it becomes active again.
  React.useEffect(() => {
    return refreshGitContext(
      { flagEnabled, workingDirectory, sessionId, isFocusedPanel, refreshToken: contextRefreshToken },
      getLiveGitContext,
      (state) => {
        setContextState(state)
        const context = state.context
        if (state.status === 'ready' && context) {
          setError(null)
          setBaseRef((previous) =>
            modeRef.current === 'managed-worktree' && previous !== null
              ? previous
              : context.currentBranch ?? context.defaultRef ?? null,
          )
        }
      },
    )
  }, [flagEnabled, workingDirectory, sessionId, isFocusedPanel, contextRefreshToken])

  // Clear session-local preparation state when the selected session changes.
  // A working-directory change within the same session must preserve a
  // just-prepared checkout until its persisted session metadata arrives.
  React.useEffect(() => {
    setPreparedState({ sessionId, result: null })
    setOpen(false)
    setPreparing(false)
  }, [sessionId])

  const loadRefs = React.useCallback(() => {
    if (!workingDirectory) return
    setRefsLoading(true)
    window.electronAPI
      ?.listGitRefs?.(workingDirectory)
      .then((result) => {
        setRefs(dedupeRefs(result.refs))
        setBaseRef((prev) => prev ?? result.currentBranch ?? result.defaultRef ?? null)
      })
      .catch(() => setRefs([]))
      .finally(() => setRefsLoading(false))
  }, [workingDirectory])

  // Load the workspace's ready managed worktrees for this repository. Identity
  // is resolved server-side from the session + working directory; worktrees
  // from other workspaces or unrelated repositories are never offered.
  const loadWorktrees = React.useCallback(() => {
    if (!sessionId || !workingDirectory) return
    setWorktreesLoading(true)
    window.electronAPI
      ?.listManagedWorktrees?.(sessionId, workingDirectory)
      .then((result) => {
        setWorktrees(result)
        // Drop a stale selection if its worktree disappeared concurrently.
        setSelectedWorktreeId((prev) =>
          prev !== null && result.some((w) => w.managedWorktreeId === prev) ? prev : null,
        )
      })
      .catch(() => setWorktrees([]))
      .finally(() => setWorktreesLoading(false))
  }, [sessionId, workingDirectory])

  const handleSelectMode = React.useCallback(
    (next: CheckoutMode, kind?: 'new' | 'existing') => {
      setError(null)
      setMode(next)
      if (next === 'managed-worktree') {
        const chosenKind = kind ?? intentKind
        setIntentKind(chosenKind)
        if (chosenKind === 'new') {
          setWorktreeNameSuffix((previous) =>
            worktreeV2Enabled ? previous ?? generateDefaultWorktreeName() : null,
          )
        }
        if (chosenKind === 'new' && refs.length === 0) loadRefs()
        if (chosenKind === 'existing' && worktrees.length === 0) loadWorktrees()
      }
    },
    [intentKind, refs.length, worktrees.length, loadRefs, loadWorktrees],
  )

  // Prepare-before-send gate (AC4). Idempotent: once prepared or already bound
  // to a persisted checkout, sending proceeds directly.
  const prepareIfNeeded = React.useCallback(async (): Promise<PrepareOutcome> => {
    const gate = resolveSendGate({
      mode,
      baseRef,
      managedWorktreeId: intentKind === 'existing' ? selectedWorktreeId : null,
      worktreeIntent: intentKind,
      worktreeV2Enabled,
      worktreeV2Pending: serverV2Pending,
      worktreeNameSuffix,
      workingDirectory: workingDirectory ?? null,
      prepared: !!prepared,
      hasPersistedCheckout: !!persistedCheckout,
      isGitRepository: contextReady && !!context?.isGitRepository,
      gitContextResolved: contextReady,
    })

    if (gate.action === 'send') return { status: 'not-needed' }
    if (gate.action === 'wait') {
      // Loading and failed refreshes need different messages: a pending
      // discovery is expected during a session/panel switch, while a failed
      // refresh is a retryable error. Only the error status re-runs discovery.
      const msg =
        contextState.status === 'error'
          ? t('git.workspace.contextRefreshFailed')
          : t('git.workspace.contextPending')
      setError(msg)
      setOpen(true)
      if (contextState.status === 'error') {
        setContextRefreshToken((token) => token + 1)
      }
      return { status: 'error', error: msg }
    }
    if (gate.action === 'block') {
      const msg =
        gate.reason === 'missing-existing-selection'
          ? t('git.workspace.existingSelectionRequired')
          : gate.reason === 'missing-worktree-name'
            ? t('git.workspace.worktreeNameRequired')
            : t('git.workspace.baseRefRequired')
      setError(msg)
      setOpen(true)
      return { status: 'error', error: msg }
    }
    if (!sessionId) {
      return { status: 'error', error: 'Missing session.' }
    }

    setPreparing(true)
    setError(null)
    try {
      const result = await window.electronAPI.prepareGitCheckout(sessionId, gate.intent)
      setPreparedState({ sessionId, result })
      setOpen(false)
      // Keep the authoritative session atom in sync immediately. The server
      // persists the checkout during preparation, but the normal working
      // directory event only carries the path. Delete-session routing needs
      // the checkout metadata before the next user action.
      if (sessionId) {
        updateSession(sessionId, (current) =>
          current
            ? {
                ...current,
                checkout: result.checkout,
                workingDirectory: result.workingDirectory,
              }
            : current,
        )
        // The server DTO carries the derived shared-owner count. Refresh it so
        // a session freshly bound to a shared worktree shows the Shared
        // worktree label immediately instead of after the next list refresh.
        window.electronAPI
          ?.getSessions?.()
          .then((sessions) => {
            const fresh = sessions.find((s) => s.id === sessionId)
            if (!fresh) return
            updateSession(sessionId, (current) =>
              current ? { ...fresh, messages: current.messages } : fresh,
            )
          })
          .catch(() => {
            /* keep the local merge; a later list refresh corrects the count */
          })
      }
      onWorkingDirectoryChange(result.workingDirectory)
      onCheckoutPrepared?.(result)
      return { status: 'ready' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setOpen(true)
      return { status: 'error', error: msg }
    } finally {
      setPreparing(false)
    }
  }, [
    mode,
    intentKind,
    baseRef,
    selectedWorktreeId,
    worktreeV2Enabled,
    serverV2Pending,
    worktreeNameSuffix,
    workingDirectory,
    prepared,
    persistedCheckout,
    context,
    contextReady,
    contextState.status,
    sessionId,
    updateSession,
    onWorkingDirectoryChange,
    onCheckoutPrepared,
    t,
  ])

  React.useImperativeHandle(ref, () => ({ prepareIfNeeded }), [prepareIfNeeded])

  const handlePrepare = React.useCallback(() => {
    void prepareIfNeeded()
  }, [prepareIfNeeded])

  if (!flagEnabled) return null

  // Keep a failed refresh visible so Send can show the retryable error instead
  // of silently dropping a pending worktree intent while the badge is hidden.
  if (error && !contextReady && workingDirectory && sessionId) {
    return (
      <FreeFormInputContextBadge
        icon={<AlertTriangle className="h-4 w-4" />}
        label={error}
        isExpanded
        hasSelection
        showChevron={false}
        className="text-destructive"
        tooltip={error}
        disabled
      />
    )
  }

  const identity = resolveCheckoutIdentity({
    isGitRepository: contextReady && !!context?.isGitRepository,
    isEmptySession,
    hasSessionId: !!sessionId,
    persistedCheckout,
    locallyPrepared: prepared?.checkout ?? null,
    sharedOwnerCount,
  })

  if (identity.kind === 'none') return null

  // Locked managed-worktree identity (prepared, resumed, or conversation-branch
  // shared). Persists for the composer lifetime even if a later send fails.
  // Every session shows the same branch label; shared ownership is conveyed by
  // the Users icon and a Shared worktree tooltip so a shared checkout never
  // hides which worktree the session is in.
  if (identity.kind === 'worktree' || identity.kind === 'shared-worktree') {
    const shared = identity.kind === 'shared-worktree'
    const branch = identity.branch ?? t('git.workspace.worktree')
    const displayName = identity.displayName ?? branch

    // AC20 — surface a visible recovery/blocked state when the managed worktree
    // was moved, removed, or externally switched. Kata never silently switches
    // directory; the user must restore the branch or delete the session.
    const recovery = resolveCheckoutRecovery({
      checkout: prepared?.checkout ?? persistedCheckout,
      contextLoaded: contextReady,
      liveBranch: context?.detached ? null : context?.currentBranch ?? null,
      liveDetached: !!context?.detached,
      checkoutExists: !!context?.isGitRepository,
    })
    if (recovery.kind !== 'ok') {
      const foundLabel =
        recovery.kind === 'branch-drift'
          ? recovery.found ?? t('git.workspace.detached')
          : ''
      const label =
        recovery.kind === 'missing'
          ? t('git.workspace.recovery.missing')
          : recovery.kind === 'blocked'
            ? t('git.workspace.recovery.blocked')
            : t('git.workspace.recovery.drift')
      const note =
        recovery.kind === 'missing'
          ? t('git.workspace.recovery.missingNote')
          : recovery.kind === 'blocked'
            ? t('git.workspace.recovery.blockedNote')
            : t('git.workspace.recovery.driftNote', {
                expected: recovery.kind === 'branch-drift' ? recovery.expected : '',
                found: foundLabel,
              })
      return (
        <FreeFormInputContextBadge
          icon={<AlertTriangle className="h-4 w-4" />}
          label={label}
          isExpanded
          hasSelection
          showChevron={false}
          className="text-destructive"
          tooltip={
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{label}</span>
              <span className="text-xs opacity-70">{note}</span>
            </span>
          }
          disabled
        />
      )
    }
    return (
      <span data-testid="git-workspace-identity">
        <FreeFormInputContextBadge
          icon={shared ? <Users className="h-4 w-4" /> : <GitFork className="h-4 w-4" />}
          label={displayName}
          isExpanded
          hasSelection
          showChevron={false}
          tooltip={
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">
                {shared ? t('git.workspace.sharedWorktree') : t('git.workspace.worktreeReady')}
              </span>
              {shared && (
                <span className="text-xs opacity-70">{t('git.workspace.sharedWorktreeNote')}</span>
              )}
              {identity.branch && (
                <span className="text-xs opacity-70">
                  {t('chat.onBranch', { branch: identity.branch })}
                </span>
              )}
            </span>
          }
          disabled
        />
      </span>
    )
  }

  const liveBranch = resolveLiveBranchLabel(
    {
      detached: !!context?.detached,
      currentBranch: context?.currentBranch ?? null,
      defaultRef: context?.defaultRef ?? null,
      identityBranch: identity.branch ?? null,
    },
    {
      detached: t('git.workspace.detached'),
      currentCheckout: t('git.workspace.currentCheckout'),
    },
  )

  // Locked / passive Current checkout identity: either a persisted current
  // checkout, or a session that already has messages.
  if (identity.kind === 'current') {
    return (
      <FreeFormInputContextBadge
        icon={<GitBranch className="h-4 w-4" />}
        label={liveBranch}
        isExpanded={false}
        hasSelection
        showChevron={false}
        tooltip={
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('git.workspace.currentCheckout')}</span>
            <span className="text-xs opacity-70">{t('chat.onBranch', { branch: liveBranch })}</span>
          </span>
        }
        disabled
      />
    )
  }

  // identity.kind === 'menu' — interactive Workspace/ref selection.
  const selectedWorktree =
    worktrees.find((w) => w.managedWorktreeId === selectedWorktreeId) ?? null
  const selectedWorktreeLabel = selectedWorktree
    ? worktreeDisplayLabel(selectedWorktree)
    : null
  const triggerLabel =
    mode === 'managed-worktree'
      ? selectedWorktree
        ? selectedWorktreeLabel ?? t('git.workspace.worktree')
        : intentKind === 'existing'
          ? t('git.workspace.existingWorktree')
          : t('git.workspace.fromRef', { ref: baseRef ?? liveBranch })
      : liveBranch

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span data-testid="git-workspace-control" className="shrink min-w-0 overflow-hidden">
          <FreeFormInputContextBadge
            icon={
              preparing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : mode === 'managed-worktree' && intentKind === 'existing' ? (
                <FolderGit2 className="h-4 w-4" />
              ) : mode === 'managed-worktree' ? (
                <GitFork className="h-4 w-4" />
              ) : (
                <GitBranch className="h-4 w-4" />
              )
            }
            label={preparing ? t('git.workspace.preparing') : triggerLabel}
            isExpanded={isEmptySession}
            hasSelection
            showChevron
            isOpen={open}
            tooltip={t('git.workspace.menuTooltip')}
          />
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className={MENU_CONTAINER_STYLE}>
        <div className="p-1">
          <button
            type="button"
            data-testid="git-workspace-current"
            onClick={() => {
              handleSelectMode('current')
              setOpen(false)
            }}
            className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
          >
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 min-w-0 truncate text-left">{t('git.workspace.currentCheckout')}</span>
            {mode === 'current' && <Check className="h-4 w-4 shrink-0" />}
          </button>
          <button
            type="button"
            data-testid="git-workspace-new-worktree"
            onClick={() => handleSelectMode('managed-worktree', 'new')}
            className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
          >
            <GitFork className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 min-w-0 truncate text-left">{t('git.workspace.newWorktree')}</span>
            {mode === 'managed-worktree' && intentKind === 'new' && <Check className="h-4 w-4 shrink-0" />}
          </button>
          <button
            type="button"
            data-testid="git-workspace-existing-worktree"
            onClick={() => handleSelectMode('managed-worktree', 'existing')}
            className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
          >
            <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 min-w-0 truncate text-left">{t('git.workspace.existingWorktree')}</span>
            {mode === 'managed-worktree' && intentKind === 'existing' && <Check className="h-4 w-4 shrink-0" />}
          </button>
        </div>

        {mode === 'managed-worktree' && intentKind === 'existing' && (
          <div className="border-t border-border/50">
            <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('git.workspace.existingWorktreesLabel')}
            </div>
            <CommandPrimitive>
              <div className="border-b border-border/50 px-3 py-2">
                <CommandPrimitive.Input
                  data-testid="git-workspace-worktree-search"
                  placeholder={t('git.workspace.searchWorktrees')}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <CommandPrimitive.List className={MENU_LIST_STYLE}>
                {worktreesLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('common.loading')}
                  </div>
                )}
                {worktrees.map((worktree) => {
                  const worktreeLabel = worktreeDisplayLabel(worktree)
                  return (
                    <CommandPrimitive.Item
                      key={worktree.managedWorktreeId}
                      value={`${worktreeLabel} ${worktree.expectedBranch} ${worktree.checkoutPath}`}
                      onSelect={() => setSelectedWorktreeId(worktree.managedWorktreeId)}
                      className={cn(MENU_ITEM_STYLE, 'items-start')}
                    >
                      <GitFork className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{worktreeLabel}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {worktree.baseRef && worktree.ownerCount > 1 &&
                          t('git.workspace.sharedFromRef', {
                            count: worktree.ownerCount - 1,
                            ref: worktree.baseRef,
                          })}
                        {worktree.baseRef && worktree.ownerCount <= 1 &&
                          t('git.workspace.fromRef', { ref: worktree.baseRef })}
                        {!worktree.baseRef && worktree.ownerCount > 1 &&
                          t('git.workspace.sharedWithCount', { count: worktree.ownerCount - 1 })}
                      </span>
                    </span>
                    {selectedWorktreeId === worktree.managedWorktreeId && (
                      <Check className="h-4 w-4 shrink-0" />
                    )}
                  </CommandPrimitive.Item>
                  )
                })}
                {!worktreesLoading && worktrees.length === 0 && (
                  <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                    {t('git.workspace.noWorktreesFound')}
                  </CommandPrimitive.Empty>
                )}
              </CommandPrimitive.List>
            </CommandPrimitive>

            <div className="border-t border-border/50 p-2">
              <p className="px-1 pb-2 text-[11px] text-muted-foreground">
                {t('git.workspace.existingWorktreeNote')}
              </p>
              {error && <p className="px-1 pb-2 text-[11px] text-destructive">{error}</p>}
              <button
                type="button"
                data-testid="git-workspace-use-worktree"
                onClick={handlePrepare}
                disabled={!selectedWorktreeId || preparing}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-[6px] bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity',
                  (!selectedWorktreeId || preparing) && 'opacity-50',
                )}
              >
                {preparing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {preparing ? t('git.workspace.preparing') : t('git.workspace.useWorktree')}
              </button>
            </div>
          </div>
        )}

        {mode === 'managed-worktree' && intentKind === 'new' && (
          <div className="border-t border-border/50">
            {worktreeV2Enabled && (
              <div className="border-b border-border/50 px-3 py-2">
                <label
                  htmlFor="git-workspace-name"
                  className="block pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {t('git.workspace.worktreeName')}
                </label>
                <input
                  id="git-workspace-name"
                  data-testid="git-workspace-name"
                  value={worktreeNameSuffix ?? ''}
                  onChange={(event) =>
                    setWorktreeNameSuffix(normalizeWorktreeNameInput(event.target.value))
                  }
                  onBlur={() =>
                    setWorktreeNameSuffix((current) => normalizeWorktreeName(current ?? ''))
                  }
                  placeholder={t('git.workspace.worktreeNamePlaceholder')}
                  className="w-full rounded-[6px] bg-muted/50 px-2.5 py-1.5 text-[13px] outline-none ring-0 placeholder:text-muted-foreground/50 focus:bg-background"
                />
                <p className="pt-1 text-[11px] text-muted-foreground">
                  {t('git.workspace.worktreeNameDesc')}
                </p>
              </div>
            )}
            <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('git.workspace.fromRefLabel')}
            </div>
            <CommandPrimitive>
              <div className="border-b border-border/50 px-3 py-2">
                <CommandPrimitive.Input
                  data-testid="git-workspace-ref-search"
                  placeholder={t('git.workspace.searchRefs')}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <CommandPrimitive.List className={MENU_LIST_STYLE}>
                {refsLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('common.loading')}
                  </div>
                )}
                {refs.map((ref) => (
                  <CommandPrimitive.Item
                    key={ref.fullName}
                    value={ref.name}
                    onSelect={() => setBaseRef(ref.name)}
                    className={MENU_ITEM_STYLE}
                  >
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 min-w-0 truncate">{ref.name}</span>
                    {baseRef === ref.name && <Check className="h-4 w-4 shrink-0" />}
                  </CommandPrimitive.Item>
                ))}
                {!refsLoading && (
                  <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                    {t('git.workspace.noRefsFound')}
                  </CommandPrimitive.Empty>
                )}
              </CommandPrimitive.List>
            </CommandPrimitive>

            <div className="border-t border-border/50 p-2">
              <p className="px-1 pb-2 text-[11px] text-muted-foreground">
                {t('git.workspace.worktreeCommittedNote')}
              </p>
              {error && <p className="px-1 pb-2 text-[11px] text-destructive">{error}</p>}
              <button
                type="button"
                data-testid="git-workspace-create"
                onClick={handlePrepare}
                disabled={!baseRef || preparing || (worktreeV2Enabled && !worktreeNameSuffix?.trim())}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-[6px] bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity',
                  (!baseRef || preparing || (worktreeV2Enabled && !worktreeNameSuffix?.trim())) && 'opacity-50',
                )}
              >
                {preparing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {preparing ? t('git.workspace.preparing') : t('git.workspace.createWorktree')}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export const WorkspaceCheckoutBadge = React.forwardRef(WorkspaceCheckoutBadgeInner)

/**
 * Whether a session is bound to a checkout (prepared in this composer, or
 * restored from persisted checkout metadata on resume).
 *
 * Once bound, the checkout owns where the session works: Git actions, the
 * Changes surface, and `sdkCwd` all resolve from the persisted checkout, so the
 * server rejects working-directory changes for a bound session. The composer
 * uses this to hide its directory selectors — the checkout badge shows the
 * bound identity in their place — so the UI never offers a mutation that would
 * be refused, or that would silently split "where the agent edits" from "what
 * Kata inspects and commits".
 */
export function useCheckoutBound(sessionId?: string): boolean {
  const session = useAtomValue(sessionAtomFamily(sessionId ?? '__no_session__'))
  return FEATURE_FLAGS.gitWorkspaceV1 && !!session?.checkout
}
WorkspaceCheckoutBadge.displayName = 'WorkspaceCheckoutBadge'
