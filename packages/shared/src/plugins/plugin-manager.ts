/**
 * Plugin Manager
 *
 * Loads builtin plugins, filters by an enabled set, collects registrations
 * into typed registries, and manages plugin lifecycle (initialize/shutdown).
 */

import type { ChannelAdapter } from '../channels/types.ts';
import type { KataPlugin, PluginContext } from './types.ts';
import { ChannelRegistryImpl, ToolRegistryImpl, ServiceRegistryImpl } from './registry-impl.ts';
import { getBuiltinPlugins } from './builtin/index.ts';

export class PluginManager {
  private plugins = new Map<string, KataPlugin>();
  private enabledIds: Set<string>;
  private channelRegistry: ChannelRegistryImpl;
  private toolRegistry: ToolRegistryImpl;
  private serviceRegistry: ServiceRegistryImpl;
  private initialized = false;

  constructor(enabledPluginIds: string[]) {
    this.enabledIds = new Set(enabledPluginIds);
    this.channelRegistry = new ChannelRegistryImpl();
    this.toolRegistry = new ToolRegistryImpl();
    this.serviceRegistry = new ServiceRegistryImpl();
  }

  /**
   * Load all builtin plugins. Enabled plugins have their registration
   * methods called; disabled plugins are tracked but not registered.
   */
  loadBuiltinPlugins(): void {
    for (const plugin of getBuiltinPlugins()) {
      this.plugins.set(plugin.id, plugin);
      if (!this.enabledIds.has(plugin.id)) continue;
      plugin.registerChannels?.(this.channelRegistry);
      plugin.registerTools?.(this.toolRegistry);
      plugin.registerServices?.(this.serviceRegistry);
    }
  }

  /**
   * Return a factory function that creates adapter instances by type.
   * Returns null for unregistered types.
   */
  getAdapterFactory(): (type: string) => ChannelAdapter | null {
    return (type) => this.channelRegistry.createAdapter(type);
  }

  /** Return metadata for all known plugins with their enabled status. */
  getRegisteredPlugins(): Array<{ id: string; name: string; version: string; enabled: boolean }> {
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      enabled: this.enabledIds.has(p.id),
    }));
  }

  /** Initialize all enabled plugins and start registered services. */
  async initializeAll(context: PluginContext): Promise<void> {
    if (this.initialized) return;
    for (const [id, plugin] of this.plugins) {
      if (!this.enabledIds.has(id)) continue;
      await plugin.initialize?.(context);
    }
    for (const [, service] of this.serviceRegistry.getServices()) {
      await service.start();
    }
    this.initialized = true;
  }

  /** Stop all services and shut down enabled plugins. */
  async shutdownAll(): Promise<void> {
    for (const [, service] of this.serviceRegistry.getServices()) {
      await service.stop();
    }
    for (const [id, plugin] of this.plugins) {
      if (!this.enabledIds.has(id)) continue;
      await plugin.shutdown?.();
    }
    this.initialized = false;
  }
}
