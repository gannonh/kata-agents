import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, FolderOpen, Server as ServerIcon } from 'lucide-react'
import { toast } from 'sonner'
import { FEATURE_FLAGS } from '@kata-sh/shared/feature-flags'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import type {
  ServerCapabilityDto,
  WorktreeSettingsSnapshot,
} from '@kata-sh/shared/protocol'
import type { RemoteServerConfig } from '@kata-sh/core/types'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Spinner } from '@kata-sh/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import {
  SettingsCard,
  SettingsCardFooter,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
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

export default function WorktreesSettingsPage() {
  const { t } = useTranslation()
  const [targets, setTargets] = useState<TargetWithCapability[]>([])
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null)
  const [root, setRoot] = useState('')
  const [savedRoot, setSavedRoot] = useState('')
  const [snapshot, setSnapshot] = useState<WorktreeSettingsSnapshot | null>(null)
  const [isLoadingTargets, setIsLoadingTargets] = useState(true)
  const [isLoadingSettings, setIsLoadingSettings] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    // A connected remote server is represented by one or more configured
    // remote-owned workspaces. Deduplicate it before capability discovery.
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
    if (!FEATURE_FLAGS.worktreeV2) return
    void loadTargets()
  }, [loadTargets])

  useEffect(() => {
    if (!selectedTarget) {
      setSnapshot(null)
      setRoot('')
      setSavedRoot('')
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

  const handleSave = useCallback(async () => {
    if (!selectedTarget || isLoadingSettings) return
    setIsSaving(true)
    setError(null)
    try {
      const next = await invokeTarget(
        selectedTarget,
        RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS,
        { materializationRoot: root },
      ) as WorktreeSettingsSnapshot
      setSnapshot(next)
      setRoot(next.materializationRoot)
      setSavedRoot(next.materializationRoot)
      toast.success(t('settings.worktrees.saved'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.worktrees.saveFailed'), { description: message })
    } finally {
      setIsSaving(false)
    }
  }, [isLoadingSettings, root, selectedTarget, t])

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
    setRoot(savedRoot)
    setError(null)
  }, [savedRoot])

  if (!FEATURE_FLAGS.worktreeV2) return null

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
          )}

          {error && <p className="px-1 text-xs text-destructive">{error}</p>}
          {(isDirty || error) && selectedTarget && (
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
    </div>
  )
}
