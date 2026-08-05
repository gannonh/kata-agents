import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderOpen,
  GitBranch,
  RefreshCw,
  RotateCcw,
  Server as ServerIcon,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import type {
  ManagedWorktreeState,
  ServerCapabilityDto,
  WorktreeArchiveResult,
  WorktreeDeleteResult,
  WorktreeInventory,
  WorktreeInventoryRow,
  WorktreePermanentDeleteResult,
  WorktreePreviewResult,
  WorktreeRestoreResult,
  WorktreeRetryResult,
  WorktreeSettingsSnapshot,
} from '@kata-sh/shared/protocol'
import type { RemoteServerConfig } from '@kata-sh/core/types'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@kata-sh/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import {
  SettingsCard,
  SettingsCardFooter,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsToggle,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'worktrees',
}

type ServerTarget =
  | {
      key: 'local'
      kind: 'local'
      serverId: string
    }
  | {
      key: string
      kind: 'remote'
      serverId: string
      remoteServer: RemoteServerConfig
    }

interface TargetWithCapability {
  target: ServerTarget
  capability: ServerCapabilityDto
}

async function invokeLocalServer(channel: string, ...args: unknown[]): Promise<unknown> {
  const status = await window.electronAPI.getServerStatus()
  if (!status.running) throw new Error('The local server is not running.')
  return window.electronAPI.invokeOnServer(status.url, status.token, channel, ...args)
}

async function invokeTarget(
  target: ServerTarget,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  if (target.kind === 'local') return invokeLocalServer(channel, ...args)
  return window.electronAPI.invokeOnServer(
    target.remoteServer.url,
    target.remoteServer.token,
    channel,
    ...args,
  )
}

function remoteKey(remoteServer: RemoteServerConfig): string {
  // A server can own several configured remote workspaces; settings are
  // server-scoped, so collapse those workspaces into one selector entry.
  return `remote:${remoteServer.url}:${remoteServer.token}`
}

function formatTime(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—'
  return new Date(ts).toLocaleString()
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Lifecycle states that allow snapshot-first deletion from the UI. Failed
 * states use Retry/Restore instead (their preview carries no fingerprint). */
const DELETABLE_STATES = new Set<ManagedWorktreeState>([
  'ready',
  'unowned',
  'missing',
])
/** States whose recovery path is restore. */
const RESTORABLE_STATES = new Set<ManagedWorktreeState>([
  'snapshotted',
  'restore-failed',
  'cleanup-failed',
])

function stateBadgeVariant(state: ManagedWorktreeState): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (state === 'ready' || state === 'unowned') return 'default'
  if (state === 'snapshotted') return 'secondary'
  if (state === 'missing' || state === 'cleanup-failed' || state === 'restore-failed') return 'destructive'
  return 'outline'
}

interface ConfirmDeleteState {
  row: WorktreeInventoryRow
  preview: WorktreePreviewResult
}

interface ConfirmPermanentState {
  row: WorktreeInventoryRow
}

export default function WorktreesSettingsPage() {
  const { t } = useTranslation()
  const [targets, setTargets] = useState<TargetWithCapability[]>([])
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null)
  const [root, setRoot] = useState('')
  const [savedRoot, setSavedRoot] = useState('')
  const [snapshot, setSnapshot] = useState<WorktreeSettingsSnapshot | null>(null)
  const [autoDeleteEnabled, setAutoDeleteEnabled] = useState(true)
  const [retentionLimit, setRetentionLimit] = useState(15)
  const [inventory, setInventory] = useState<WorktreeInventory | null>(null)
  const [isLoadingTargets, setIsLoadingTargets] = useState(true)
  const [isLoadingSettings, setIsLoadingSettings] = useState(false)
  const [isLoadingInventory, setIsLoadingInventory] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [busyRowId, setBusyRowId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteState | null>(null)
  const [confirmPermanent, setConfirmPermanent] = useState<ConfirmPermanentState | null>(null)
  const [permanentTyped, setPermanentTyped] = useState('')

  const selectedTarget = useMemo(
    () => targets.find(({ target }) => target.key === selectedTargetKey)?.target ?? null,
    [selectedTargetKey, targets],
  )
  const isDirty = root !== savedRoot

  const loadTargets = useCallback(async () => {
    setIsLoadingTargets(true)
    setError(null)
    const discovered: TargetWithCapability[] = []

    try {
      const localCapability = await invokeLocalServer(RPC_CHANNELS.git.GET_CAPABILITIES) as ServerCapabilityDto
      if (localCapability?.worktreeV2) {
        discovered.push({
          target: { key: 'local', kind: 'local', serverId: localCapability.serverId },
          capability: localCapability,
        })
      }
    } catch (err) {
      console.warn('[WorktreesSettingsPage] local capability unavailable:', err)
    }

    const remoteServers = new Map<string, RemoteServerConfig>()
    try {
      for (const workspace of await window.electronAPI.getWorkspaces()) {
        if (workspace.remoteServer?.url && workspace.remoteServer.token) {
          remoteServers.set(remoteKey(workspace.remoteServer), workspace.remoteServer)
        }
      }
    } catch (err) {
      console.warn('[WorktreesSettingsPage] failed to list configured servers:', err)
    }

    const remoteResults = await Promise.all(
      [...remoteServers.values()].map(async (remoteServer): Promise<TargetWithCapability | null> => {
        try {
          const capability = await window.electronAPI.invokeOnServer(
            remoteServer.url,
            remoteServer.token,
            RPC_CHANNELS.git.GET_CAPABILITIES,
          ) as ServerCapabilityDto
          if (!capability?.worktreeV2) return null
          return {
            target: {
              key: remoteKey(remoteServer),
              kind: 'remote',
              serverId: capability.serverId,
              remoteServer,
            },
            capability,
          }
        } catch (err) {
          console.warn('[WorktreesSettingsPage] remote capability unavailable:', err)
          return null
        }
      }),
    )
    discovered.push(...remoteResults.filter((entry): entry is TargetWithCapability => entry !== null))

    setTargets(discovered)
    setSelectedTargetKey((current) =>
      current && discovered.some(({ target }) => target.key === current)
        ? current
        : discovered[0]?.target.key ?? null,
    )
    if (discovered.length === 0) {
      setError(t('settings.worktrees.noCapableServers'))
    }
    setIsLoadingTargets(false)
  }, [t])

  useEffect(() => {
    void loadTargets()
  }, [loadTargets])

  useEffect(() => {
    if (!selectedTarget) {
      setSnapshot(null)
      setRoot('')
      setSavedRoot('')
      setInventory(null)
      return
    }

    let cancelled = false
    setIsLoadingSettings(true)
    setError(null)
    void invokeTarget(selectedTarget, RPC_CHANNELS.git.GET_WORKTREE_SETTINGS)
      .then((value) => {
        if (cancelled) return
        const next = value as WorktreeSettingsSnapshot
        setSnapshot(next)
        setRoot(next.materializationRoot)
        setSavedRoot(next.materializationRoot)
        setAutoDeleteEnabled(next.autoDeleteEnabled)
        setRetentionLimit(next.retentionLimit)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setSnapshot(null)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSettings(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedTarget])

  const loadInventory = useCallback(async () => {
    if (!selectedTarget) return
    const targetKey = selectedTarget.key
    setIsLoadingInventory(true)
    try {
      const next = await invokeTarget(
        selectedTarget,
        RPC_CHANNELS.git.WORKTREE_INVENTORY,
      ) as WorktreeInventory
      // A target switch while the request was in flight must not apply this
      // server's inventory to another server's page state.
      if (selectedTargetKey !== targetKey) return
      setInventory(next)
    } catch (err) {
      if (selectedTargetKey !== targetKey) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.worktrees.inventoryFailed'), { description: message })
    } finally {
      if (selectedTargetKey === targetKey) setIsLoadingInventory(false)
    }
  }, [selectedTarget, selectedTargetKey, t])

  useEffect(() => {
    if (!selectedTarget) return
    void loadInventory()
  }, [selectedTarget, loadInventory])

  const handleSave = useCallback(async () => {
    if (!selectedTarget || isLoadingSettings) return
    setIsSaving(true)
    setError(null)
    try {
      const next = await invokeTarget(
        selectedTarget,
        RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS,
        {
          materializationRoot: root,
          autoDeleteEnabled,
          retentionLimit: Math.min(1000, Math.max(1, Math.trunc(retentionLimit))),
        },
      ) as WorktreeSettingsSnapshot
      setSnapshot(next)
      setRoot(next.materializationRoot)
      setSavedRoot(next.materializationRoot)
      setAutoDeleteEnabled(next.autoDeleteEnabled)
      setRetentionLimit(next.retentionLimit)
      toast.success(t('settings.worktrees.saved'))
      void loadInventory()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.worktrees.saveFailed'), { description: message })
    } finally {
      setIsSaving(false)
    }
  }, [autoDeleteEnabled, isLoadingSettings, loadInventory, retentionLimit, root, selectedTarget, t])

  const handleBrowse = useCallback(async () => {
    if (!selectedTarget || selectedTarget.kind !== 'local' || isLoadingSettings) return
    try {
      const selected = await window.electronAPI.openFolderDialog()
      if (selected) setRoot(selected)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.worktrees.browseFailed'), { description: message })
    }
  }, [isLoadingSettings, selectedTarget, t])

  const handleReset = useCallback(() => {
    if (!snapshot) return
    setRoot(savedRoot)
    setAutoDeleteEnabled(snapshot.autoDeleteEnabled)
    setRetentionLimit(snapshot.retentionLimit)
    setError(null)
  }, [savedRoot, snapshot])

  const runRowAction = useCallback(
    async (row: WorktreeInventoryRow, action: () => Promise<unknown>) => {
      if (!selectedTarget) return
      setBusyRowId(row.managedWorktreeId)
      setError(null)
      try {
        await action()
        await loadInventory()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        toast.error(t('settings.worktrees.actionFailed'), { description: message })
      } finally {
        setBusyRowId(null)
      }
    },
    [loadInventory, selectedTarget, t],
  )

  const handleDeleteClick = useCallback(
    async (row: WorktreeInventoryRow) => {
      if (!selectedTarget) return
      const targetKey = selectedTarget.key
      setBusyRowId(row.managedWorktreeId)
      setError(null)
      try {
        const preview = await invokeTarget(
          selectedTarget,
          RPC_CHANNELS.git.WORKTREE_PREVIEW,
          row.managedWorktreeId,
        ) as WorktreePreviewResult
        // The preview belongs to the target it was fetched from; never present
        // it as a confirmation for a different server.
        if (selectedTargetKey !== targetKey) return
        setConfirmDelete({ row, preview })
      } catch (err) {
        if (selectedTargetKey !== targetKey) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        toast.error(t('settings.worktrees.previewFailed'), { description: message })
      } finally {
        if (selectedTargetKey === targetKey) setBusyRowId(null)
      }
    },
    [selectedTarget, selectedTargetKey, t],
  )

  const confirmDeleteAction = useCallback(async () => {
    if (!selectedTarget || !confirmDelete) return
    setBusyRowId(confirmDelete.row.managedWorktreeId)
    try {
      const result = await invokeTarget(
        selectedTarget,
        RPC_CHANNELS.git.WORKTREE_DELETE,
        {
          managedWorktreeId: confirmDelete.row.managedWorktreeId,
          previewFingerprint: confirmDelete.preview.previewFingerprint,
        },
      ) as WorktreeDeleteResult
      setConfirmDelete(null)
      if (!result.deleted) {
        toast.error(t('settings.worktrees.deleteFailed'), {
          description: result.error ?? t('settings.worktrees.deleteBlocked'),
        })
        return
      }
      toast.success(t('settings.worktrees.deleted'))
      await loadInventory()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('settings.worktrees.deleteFailed'), { description: message })
    } finally {
      setBusyRowId(null)
    }
  }, [confirmDelete, loadInventory, selectedTarget, t])

  const handleRestore = useCallback(
    (row: WorktreeInventoryRow) =>
      runRowAction(row, () =>
        invokeTarget(selectedTarget!, RPC_CHANNELS.git.WORKTREE_RESTORE, row.managedWorktreeId) as Promise<WorktreeRestoreResult>,
      ),
    [runRowAction, selectedTarget],
  )

  const handleRetry = useCallback(
    (row: WorktreeInventoryRow) =>
      runRowAction(row, () =>
        invokeTarget(selectedTarget!, RPC_CHANNELS.git.WORKTREE_RETRY, { managedWorktreeId: row.managedWorktreeId }) as Promise<WorktreeRetryResult>,
      ),
    [runRowAction, selectedTarget],
  )

  const handleArchive = useCallback(
    (row: WorktreeInventoryRow, sessionId: string, archived: boolean) =>
      runRowAction(row, () =>
        invokeTarget(
          selectedTarget!,
          archived ? RPC_CHANNELS.git.WORKTREE_UNARCHIVE : RPC_CHANNELS.git.WORKTREE_ARCHIVE,
          { managedWorktreeId: row.managedWorktreeId, sessionId, archived },
        ) as Promise<WorktreeArchiveResult>,
      ),
    [runRowAction, selectedTarget],
  )

  const confirmPermanentAction = useCallback(async () => {
    if (!selectedTarget || !confirmPermanent) return
    if (permanentTyped.trim().toLowerCase() !== 'delete') return
    setBusyRowId(confirmPermanent.row.managedWorktreeId)
    try {
      const result = await invokeTarget(
        selectedTarget,
        RPC_CHANNELS.git.WORKTREE_PERMANENT_DELETE,
        {
          managedWorktreeId: confirmPermanent.row.managedWorktreeId,
          confirmIrreversible: true,
        },
      ) as WorktreePermanentDeleteResult
      setConfirmPermanent(null)
      setPermanentTyped('')
      if (!result.deleted) {
        toast.error(t('settings.worktrees.permanentDeleteFailed'), { description: result.error })
        return
      }
      toast.success(t('settings.worktrees.permanentlyDeleted'))
      await loadInventory()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('settings.worktrees.permanentDeleteFailed'), { description: message })
    } finally {
      setBusyRowId(null)
    }
  }, [confirmPermanent, loadInventory, permanentTyped, selectedTarget, t])

  const pendingPolicyDirty =
    snapshot !== null &&
    (autoDeleteEnabled !== snapshot.autoDeleteEnabled || retentionLimit !== snapshot.retentionLimit)

  if (isLoadingTargets) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div data-testid="worktrees-settings-page" className="flex h-full flex-col">
      <PanelHeader title={t('settings.worktrees.title')} />
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl space-y-5 px-5 py-7">
          <SettingsSection
            title={t('settings.worktrees.serverSection')}
            description={t('settings.worktrees.serverSectionDesc')}
          >
            <SettingsCard>
              <SettingsSelect
                label={t('settings.worktrees.server')}
                description={t('settings.worktrees.serverDesc')}
                value={selectedTargetKey ?? ''}
                onValueChange={setSelectedTargetKey}
                disabled={targets.length === 0 || isLoadingSettings}
                options={targets.map(({ target }) => ({
                  value: target.key,
                  label: target.kind === 'local'
                    ? `${t('settings.worktrees.localServer')} · ${target.serverId}`
                    : `${t('settings.worktrees.remoteServer')} · ${target.serverId}`,
                }))}
                placeholder={t('settings.worktrees.selectServer')}
                inCard
              />
              {selectedTarget && (
                <SettingsRow
                  label={t('settings.worktrees.serverIdentity')}
                  description={selectedTarget.kind === 'remote'
                    ? t('settings.worktrees.remotePathNotice', { serverId: selectedTarget.serverId })
                    : t('settings.worktrees.localPathNotice', { serverId: selectedTarget.serverId })}
                >
                  <ServerIcon className="h-4 w-4 text-muted-foreground" />
                </SettingsRow>
              )}
            </SettingsCard>
          </SettingsSection>

          {selectedTarget && snapshot && (
            <>
              <SettingsSection
                title={t('settings.worktrees.rootSection')}
                description={t('settings.worktrees.rootSectionDesc')}
              >
                <SettingsCard>
                  <div data-testid="worktrees-root-input">
                    <SettingsInput
                    label={t('settings.worktrees.root')}
                    description={t('settings.worktrees.rootDesc')}
                    value={root}
                    onChange={setRoot}
                    placeholder={t('settings.worktrees.rootPlaceholder')}
                    disabled={isLoadingSettings || isSaving}
                    inCard
                    action={selectedTarget.kind === 'local' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 shrink-0"
                        onClick={handleBrowse}
                        disabled={isLoadingSettings || isSaving}
                      >
                        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                        {t('settings.worktrees.browse')}
                      </Button>
                    ) : undefined}
                    />
                  </div>
                  <SettingsRow
                    label={t('settings.worktrees.existingWorktrees')}
                    description={t('settings.worktrees.existingWorktreesDesc')}
                  >
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              <SettingsSection
                title={t('settings.worktrees.cleanupSection')}
                description={t('settings.worktrees.cleanupSectionDesc')}
              >
                <SettingsCard>
                  <div data-testid="worktrees-auto-delete">
                    <SettingsRow
                      label={t('settings.worktrees.autoDelete')}
                      description={t('settings.worktrees.autoDeleteDesc')}
                    >
                      <SettingsToggle
                        label={t('settings.worktrees.autoDelete')}
                        checked={autoDeleteEnabled}
                        onCheckedChange={setAutoDeleteEnabled}
                        disabled={isSaving}
                      />
                    </SettingsRow>
                  </div>
                  <div data-testid="worktrees-retention-limit">
                    <SettingsInput
                      label={t('settings.worktrees.retentionLimit')}
                      description={t('settings.worktrees.retentionLimitDesc')}
                      value={String(retentionLimit)}
                      onChange={(value) => {
                        const parsed = Number(value)
                        if (Number.isFinite(parsed)) setRetentionLimit(parsed)
                      }}
                      disabled={isSaving}
                      inCard
                    />
                  </div>
                  {inventory?.lastCleanupResult && (
                    <SettingsRow
                      label={t('settings.worktrees.lastCleanup')}
                      description={`${formatTime(inventory.lastCleanupResult.at)} · ${t(
                        `settings.worktrees.cleanupOutcome.${inventory.lastCleanupResult.outcome}`,
                      )}${inventory.lastCleanupResult.reason ? ` — ${inventory.lastCleanupResult.reason}` : ''}`}
                    >
                      <span className="text-xs text-muted-foreground">
                        {inventory.lastCleanupResult.removedWorktreeId
                          ? t('settings.worktrees.cleanupRemoved', {
                              id: inventory.lastCleanupResult.removedWorktreeId,
                            })
                          : ''}
                      </span>
                    </SettingsRow>
                  )}
                </SettingsCard>
              </SettingsSection>
            </>
          )}

          {selectedTarget && (
            <SettingsSection
              title={t('settings.worktrees.inventorySection')}
              description={t('settings.worktrees.inventorySectionDesc')}
            >
              <SettingsCard>
                <div className="flex items-center justify-between px-4 pt-3">
                  <p className="text-xs text-muted-foreground">
                    {inventory
                      ? t('settings.worktrees.inventoryCounts', {
                          total: inventory.counts.total,
                          materialized: inventory.counts.materialized,
                          missing: inventory.counts.missing,
                          snapshotted: inventory.counts.snapshotted,
                          cleanupFailed: inventory.counts.cleanupFailed,
                          restoreFailed: inventory.counts.restoreFailed,
                        })
                      : ''}
                  </p>
                  <Button
                    data-testid="worktrees-inventory-refresh"
                    variant="ghost"
                    size="sm"
                    onClick={() => void loadInventory()}
                    disabled={isLoadingInventory}
                  >
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isLoadingInventory ? 'animate-spin' : ''}`} />
                    {t('common.refresh')}
                  </Button>
                </div>
                {isLoadingInventory && inventory === null ? (
                  <div className="flex justify-center py-8">
                    <Spinner />
                  </div>
                ) : inventory && inventory.rows.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('settings.worktrees.inventoryEmpty')}
                  </p>
                ) : (
                  <div className="divide-y" data-testid="worktrees-inventory">
                    {inventory?.rows.map((row) => (
                      <div
                        key={row.managedWorktreeId}
                        data-testid={`worktree-row-${row.managedWorktreeId}`}
                        className="space-y-2 px-4 py-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{row.displayName}</span>
                          <Badge variant={stateBadgeVariant(row.state)} data-testid="worktree-row-state">
                            {t(`settings.worktrees.state.${row.state}`)}
                          </Badge>
                          {row.state === 'unowned' && (
                            <Badge variant="secondary">{t('settings.worktrees.unownedBadge')}</Badge>
                          )}
                          <span className="text-xs text-muted-foreground">{row.expectedBranch}</span>
                        </div>
                        <div className="grid gap-1 text-xs text-muted-foreground">
                          <div className="flex flex-wrap gap-x-4">
                            <span>{t('settings.worktrees.workspace')}: {row.workspaceId}</span>
                            <span>{t('settings.worktrees.repository')}: {row.repositoryRoot}</span>
                            <span>{t('settings.worktrees.checkoutPath')}: {row.checkoutPath}</span>
                          </div>
                          <div className="flex flex-wrap gap-x-4">
                            <span>{t('settings.worktrees.createdAt')}: {formatTime(row.createdAt)}</span>
                            <span>{t('settings.worktrees.lastUsedAt')}: {formatTime(row.lastUsedAt)}</span>
                            {row.snapshot && (
                              <span>
                                {t('settings.worktrees.snapshotMeta', {
                                  at: formatTime(row.snapshot.createdAt),
                                  files: row.snapshot.fileCount,
                                  bytes: formatBytes(row.snapshot.totalBytes),
                                })}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{t('settings.worktrees.owners')}:</span>
                            {row.owners.map((owner) => (
                              <span
                                key={owner.sessionId}
                                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                                data-testid={`worktree-owner-${owner.sessionId}`}
                              >
                                {owner.sessionId}
                                {owner.archived && (
                                  <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                                    {t('settings.worktrees.archivedBadge')}
                                  </Badge>
                                )}
                                {owner.active && (
                                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                    {t('settings.worktrees.activeBadge')}
                                  </Badge>
                                )}
                                {owner.flagged && (
                                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                    {t('settings.worktrees.flaggedBadge')}
                                  </Badge>
                                )}
                                <button
                                  type="button"
                                  className="text-[10px] underline-offset-2 hover:underline"
                                  disabled={busyRowId === row.managedWorktreeId}
                                  onClick={() => void handleArchive(row, owner.sessionId, owner.archived)}
                                >
                                  {owner.archived
                                    ? t('settings.worktrees.unarchive')
                                    : t('settings.worktrees.archive')}
                                </button>
                              </span>
                            ))}
                          </div>
                          {row.lastError && (
                            <p className="text-destructive" data-testid="worktree-row-error">
                              {row.lastError}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2 pt-1">
                          {DELETABLE_STATES.has(row.state) && (
                            <Button
                              data-testid={`worktree-delete-${row.managedWorktreeId}`}
                              variant="destructive"
                              size="sm"
                              disabled={busyRowId === row.managedWorktreeId}
                              onClick={() => void handleDeleteClick(row)}
                            >
                              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                              {row.state === 'missing'
                                ? t('settings.worktrees.removeRecord')
                                : t('settings.worktrees.delete')}
                            </Button>
                          )}
                          {RESTORABLE_STATES.has(row.state) && (
                            <Button
                              data-testid={`worktree-restore-${row.managedWorktreeId}`}
                              variant="outline"
                              size="sm"
                              disabled={busyRowId === row.managedWorktreeId}
                              onClick={() => void handleRestore(row)}
                            >
                              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                              {t('settings.worktrees.restore')}
                            </Button>
                          )}
                          {(row.state === 'cleanup-failed' || row.state === 'restore-failed') && (
                            <Button
                              data-testid={`worktree-retry-${row.managedWorktreeId}`}
                              variant="outline"
                              size="sm"
                              disabled={busyRowId === row.managedWorktreeId}
                              onClick={() => void handleRetry(row)}
                            >
                              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                              {t('settings.worktrees.retry')}
                            </Button>
                          )}
                          {(row.state === 'snapshotted' || row.state === 'restore-failed') &&
                            row.owners.length === 0 && (
                              <Button
                                data-testid={`worktree-permanent-delete-${row.managedWorktreeId}`}
                                variant="ghost"
                                size="sm"
                                disabled={busyRowId === row.managedWorktreeId}
                                onClick={() => {
                                  setConfirmPermanent({ row })
                                  setPermanentTyped('')
                                }}
                              >
                                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                {t('settings.worktrees.permanentDelete')}
                              </Button>
                            )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SettingsCard>
            </SettingsSection>
          )}

          {error && <p className="px-1 text-xs text-destructive">{error}</p>}
          {(isDirty || pendingPolicyDirty) && selectedTarget && (
            <SettingsCardFooter>
              <Button variant="outline" size="sm" onClick={handleReset} disabled={isSaving}>
                {t('common.reset')}
              </Button>
              <Button data-testid="worktrees-save" size="sm" onClick={handleSave} disabled={isSaving || isLoadingSettings || !snapshot}>
                {isSaving ? <Spinner className="mr-1.5" /> : null}
                {t('common.save')}
              </Button>
            </SettingsCardFooter>
          )}
        </div>
      </ScrollArea>

      {confirmDelete && (
        <Dialog open onOpenChange={(open) => { if (!open) setConfirmDelete(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.worktrees.confirmDeleteTitle', { name: confirmDelete.row.displayName })}</DialogTitle>
              <DialogDescription>{t('settings.worktrees.confirmDeleteDesc')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p>
                {t('settings.worktrees.confirmDeleteBranch', { branch: confirmDelete.row.expectedBranch })}
              </p>
              <p>
                {t('settings.worktrees.confirmDeleteOwners', {
                  owners: confirmDelete.preview.owners.map((o) => o.sessionId).join(', ') || '—',
                })}
              </p>
              {confirmDelete.preview.blocked ? (
                <p className="text-destructive">{confirmDelete.preview.blockedReason}</p>
              ) : (
                <>
                  <p>
                    {t('settings.worktrees.confirmDeleteWork', {
                      files: confirmDelete.preview.uncommittedFileCount,
                      commits: confirmDelete.preview.unpushedCommitCount,
                    })}
                  </p>
                  <p className="text-muted-foreground">
                    {t('settings.worktrees.confirmDeleteIgnored', {
                      count: confirmDelete.preview.ignoredPolicy.includeFileCount,
                    })}
                  </p>
                  <p className="text-muted-foreground">{t('settings.worktrees.confirmDeleteSnapshot')}</p>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                data-testid="worktrees-confirm-delete"
                variant="destructive"
                size="sm"
                disabled={confirmDelete.preview.blocked || busyRowId === confirmDelete.row.managedWorktreeId}
                onClick={() => void confirmDeleteAction()}
              >
                {t('settings.worktrees.confirmDeleteAction')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {confirmPermanent && (
        <Dialog open onOpenChange={(open) => { if (!open) { setConfirmPermanent(null); setPermanentTyped('') } }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.worktrees.confirmPermanentTitle', { name: confirmPermanent.row.displayName })}</DialogTitle>
              <DialogDescription>{t('settings.worktrees.confirmPermanentDesc')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 text-sm">
              <p>{t('settings.worktrees.confirmPermanentBranch', { branch: confirmPermanent.row.expectedBranch })}</p>
              <p className="text-destructive">{t('settings.worktrees.confirmPermanentIrreversible')}</p>
              <input
                data-testid="worktrees-permanent-confirm-input"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="delete"
                value={permanentTyped}
                onChange={(event) => setPermanentTyped(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => { setConfirmPermanent(null); setPermanentTyped('') }}>
                {t('common.cancel')}
              </Button>
              <Button
                data-testid="worktrees-confirm-permanent-delete"
                variant="destructive"
                size="sm"
                disabled={permanentTyped.trim().toLowerCase() !== 'delete' || busyRowId === confirmPermanent.row.managedWorktreeId}
                onClick={() => void confirmPermanentAction()}
              >
                {t('settings.worktrees.confirmPermanentAction')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
