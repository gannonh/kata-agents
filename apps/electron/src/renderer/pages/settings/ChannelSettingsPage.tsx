/**
 * ChannelSettingsPage
 *
 * Displays configured channel adapters for the active workspace with
 * enable/disable toggles, daemon status, and start/stop controls.
 *
 * Channel configuration is done via CLI; this page manages
 * existing configs and provides daemon lifecycle controls.
 */

import * as React from "react";
import { useState, useEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { Hash, MessageCircle, Radio, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PanelHeader } from "@/components/app-shell/PanelHeader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { HeaderMenu } from "@/components/ui/HeaderMenu";
import { Spinner } from "@craft-agent/ui";
import { useAppShellContext } from "@/context/AppShellContext";
import { cn } from "@/lib/utils";
import { routes } from "@/lib/navigate";
import { daemonStateAtom } from "@/atoms/daemon";
import { DaemonStatusIndicator } from "@/components/ui/daemon-status-indicator";
import type { ChannelConfig } from "@craft-agent/shared/channels";
import type { DetailsPageMeta } from "@/lib/navigation-registry";

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from "@/components/settings";

export const meta: DetailsPageMeta = {
  navigator: "settings",
  slug: "channels",
};

/** Icon for a channel adapter type */
function AdapterIcon({ adapter }: { adapter: string }) {
  if (adapter === "slack")
    return <Hash className="h-4 w-4 text-muted-foreground" />;
  if (adapter === "whatsapp")
    return <MessageCircle className="h-4 w-4 text-muted-foreground" />;
  return <Radio className="h-4 w-4 text-muted-foreground" />;
}

export default function ChannelSettingsPage() {
  const { activeWorkspaceId } = useAppShellContext();
  const daemonState = useAtomValue(daemonStateAtom);

  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const isDaemonTransitioning =
    daemonState === "starting" || daemonState === "stopping";

  useEffect(() => {
    if (!activeWorkspaceId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    window.electronAPI
      .getChannels(activeWorkspaceId)
      .then((configs) => {
        setChannels(configs || []);
      })
      .catch((err) => {
        console.error("[ChannelSettings] Failed to load channels:", err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [activeWorkspaceId]);

  const handleToggleChannel = useCallback(
    async (channel: ChannelConfig, enabled: boolean) => {
      if (!activeWorkspaceId) return;
      const updated = { ...channel, enabled };
      try {
        await window.electronAPI.updateChannel(activeWorkspaceId, updated);
        setChannels((prev) =>
          prev.map((c) => (c.slug === channel.slug ? updated : c)),
        );
      } catch (err) {
        console.error("[ChannelSettings] Failed to update channel:", err);
        toast.error("Failed to update channel");
      }
    },
    [activeWorkspaceId],
  );

  const handleDeleteChannel = useCallback(
    async (slug: string) => {
      if (!activeWorkspaceId) return;
      try {
        await window.electronAPI.deleteChannel(activeWorkspaceId, slug);
        setChannels((prev) => prev.filter((c) => c.slug !== slug));
        toast.success("Channel deleted");
      } catch (err) {
        console.error("[ChannelSettings] Failed to delete channel:", err);
        toast.error("Failed to delete channel");
      }
    },
    [activeWorkspaceId],
  );

  const handleDaemonToggle = useCallback(async () => {
    try {
      if (daemonState === "running") {
        await window.electronAPI.stopDaemon();
      } else {
        await window.electronAPI.startDaemon();
      }
    } catch (err) {
      console.error("[ChannelSettings] Daemon toggle failed:", err);
      toast.error("Failed to toggle daemon");
    }
  }, [daemonState]);

  const header = (
    <PanelHeader
      title="Channels"
      actions={
        <HeaderMenu
          route={routes.view.settings("channels")}
          helpFeature="channels"
        />
      }
    />
  );

  if (!activeWorkspaceId) {
    return (
      <div className="h-full flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">
            No workspace selected
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="h-full flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center">
          <Spinner className="text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {header}
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Daemon Status */}
              <SettingsSection title="Daemon">
                <SettingsCard>
                  <SettingsRow
                    label="Status"
                    action={
                      <button
                        type="button"
                        onClick={handleDaemonToggle}
                        disabled={isDaemonTransitioning}
                        className={cn(
                          "inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal transition-colors",
                          isDaemonTransitioning
                            ? "opacity-50 cursor-not-allowed"
                            : "hover:bg-foreground/[0.02]",
                        )}
                      >
                        {daemonState === "running" ? "Stop" : "Start"}
                      </button>
                    }
                  >
                    <DaemonStatusIndicator state={daemonState} size="sm" />
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* Channels List */}
              <SettingsSection
                title="Configured Channels"
                description="Channel sessions inherit MCP tools from workspace sources."
              >
                {channels.length === 0 ? (
                  <div className="rounded-xl border border-border/50 p-6">
                    <p className="text-sm text-muted-foreground text-center">
                      No channels configured. Use the CLI to add channels.
                    </p>
                  </div>
                ) : (
                  <SettingsCard>
                    {channels.map((channel) => (
                      <SettingsRow
                        key={channel.slug}
                        label={
                          <span className="flex items-center gap-2">
                            <AdapterIcon adapter={channel.adapter} />
                            <span>{channel.slug}</span>
                            <span className="text-xs text-muted-foreground">
                              {channel.adapter}
                            </span>
                          </span>
                        }
                        action={
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleDeleteChannel(channel.slug)}
                              className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                              title="Delete channel"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        }
                      >
                        <Switch
                          checked={channel.enabled}
                          onCheckedChange={(checked) =>
                            handleToggleChannel(channel, checked)
                          }
                        />
                      </SettingsRow>
                    ))}
                  </SettingsCard>
                )}
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
