import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FolderOpen,
  GitBranch,
  RefreshCw,
  Server as ServerIcon,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import type {
  ServerCapabilityDto,
  WorktreeDeleteResult,
  WorktreeInventory,
  WorktreeInventoryRow,
  WorktreePreviewResult,
  WorktreeSettingsSnapshot,
} from '@kata-sh/shared/protocol'
import type { RemoteServerConfig } from '@kata-sh/core/types'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
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

interface ConfirmDeleteState {
  row: WorktreeInventoryRow
  preview: WorktreePreviewResult
  /** Target the preview was fetched from; the delete must still be current. */
  targetKey: string
}

export default function WorktreesSettingsPage() {
  const { t } = useTranslation()
  const [targets, setTargets] = useState<TargetWithCapability[]>([])
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null)
  const [root, setRoot] = useState('')
  const [savedRoot, setSavedRoot] = useState('')
  const [snapshot, setSnapshot] = useState<WorktreeSettingsSnapshot | null>(null)
  const [autoDeleteEnabled, setAutoDeleteEnabled] = useState(false)
  const [retentionLimit, setRetentionLimit] = useState(15)
  const [inventory, setInventory] = useState<WorktreeInventory | null>(null)
  const [isLoadingTargets, setIsLoadingTargets] = useState(true)
  const [isLoadingSettings, setIsLoadingSettings] = useState(false)
  const [isLoadingInventory, setIsLoadingInventory] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [busyRowId, setBusyRowId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDeleteState | null>(null)

  const selectedTarget = useMemo(
    () => targets.find(({ target }) => target.key === selectedTargetKey)?.target ?? null,
    [selectedTargetKey, targets],
  )
  // Live target identity for in-flight request guards: the render-time closure
  // of selectedTargetKey is stale while a request is awaited, so stale
  // responses must be compared against the CURRENT selection, not the captured
  // one.
  const selectedTargetKeyRef = useRef(selectedTargetKey)
  selectedTargetKeyRef.current = selectedTargetKey
  const isCurrentTarget = useCallback((key: string | null): boolean => {
    return selectedTargetKeyRef.current === key
  }, [])
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
      if (!isCurrentTarget(targetKey)) return
      setInventory(next)
    } catch (err) {
      if (!isCurrentTarget(targetKey)) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.worktrees.inventoryFailed'), { description: message })
    } finally {
      if (isCurrentTarget(targetKey)) setIsLoadingInventory(false)
    }
  }, [isCurrentTarget, selectedTarget, t])

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
        if (!isCurrentTarget(targetKey)) return
        setConfirmDelete({ row, preview, targetKey })
      } catch (err) {
        if (!isCurrentTarget(targetKey)) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        toast.error(t('settings.worktrees.previewFailed'), { description: message })
      } finally {
        if (isCurrentTarget(targetKey)) setBusyRowId(null)
      }
    },
    [isCurrentTarget, selectedTarget, t],
  )

  const confirmDeleteAction = useCallback(async () => {
    if (!selectedTarget || !confirmDelete) return
    // A target switch after the preview invalidates the confirmation entirely:
    // server A's fingerprint must never authorize a delete on server B.
    if (!isCurrentTarget(confirmDelete.targetKey)) {
      setConfirmDelete(null)
      return
    }
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
  }, [confirmDelete, isCurrentTarget, loadInventory, selectedTarget, t])

  const pendingPolicyDirty =
    snapshot !== null &&
    (autoDeleteEnabled !== snapshot.autoDeleteEnabled || retentionLimit !== snapshot.retentionLimit)
  // The management list is intentionally limited to worktrees that still have
  // a checkout. Snapshot and recovery records remain server-side for lifecycle
  // safety, but they are not presented as extra actions in this simple list.
  const activeRows = inventory?.rows.filter(
    (row) => row.state === 'ready' || row.state === 'unowned',
  ) ?? []

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
                    {inventory ? t('settings.worktrees.inventoryCount', { count: activeRows.length }) : ''}
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
                ) : activeRows.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('settings.worktrees.inventoryEmpty')}
                  </p>
                ) : (
                  <div className="divide-y" data-testid="worktrees-inventory">
                    {activeRows.map((row) => (
                      <div
                        key={row.managedWorktreeId}
                        data-testid={`worktree-row-${row.managedWorktreeId}`}
                        className="flex items-center justify-between gap-4 px-4 py-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="font-medium">{row.displayName}</span>
                            <span className="text-xs text-muted-foreground">{row.expectedBranch}</span>
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {row.checkoutPath}
                          </p>
                        </div>
                        <Button
                          data-testid={`worktree-delete-${row.managedWorktreeId}`}
                          variant="destructive"
                          size="sm"
                          className="shrink-0"
                          disabled={busyRowId === row.managedWorktreeId}
                          onClick={() => void handleDeleteClick(row)}
                        >
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                          {t('settings.worktrees.delete')}
                        </Button>
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
              {confirmDelete.preview.owners.length > 0 && (
                <p className="text-muted-foreground">
                  {t('settings.worktrees.confirmDeleteOwners', {
                    owners: confirmDelete.preview.owners.map((owner) => owner.sessionId).join(', '),
                  })}
                </p>
              )}
              {confirmDelete.preview.blocked ? (
                <p className="text-destructive">{confirmDelete.preview.blockedReason}</p>
              ) : (
                <p>
                  {t('settings.worktrees.confirmDeleteWork', {
                    files: confirmDelete.preview.uncommittedFileCount,
                    commits: confirmDelete.preview.unpushedCommitCount,
                  })}
                </p>
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

    </div>
  )
}
