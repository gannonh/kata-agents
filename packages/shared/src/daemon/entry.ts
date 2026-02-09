/**
 * Daemon Entry Point
 *
 * Standalone script executed as a Bun subprocess by the Electron main process.
 * Reads DaemonCommand objects from stdin (JSON-lines), emits DaemonEvent objects
 * to stdout (JSON-lines), and logs to stderr.
 *
 * This file is NOT exported from the barrel. It runs as its own process.
 */

import { join } from 'path';
import { homedir } from 'os';
import type { DaemonCommand, DaemonEvent, TaskType, TaskAction } from './types.ts';
import type { ChannelConfig } from '../channels/types.ts';
import { createLineParser, formatMessage } from './ipc.ts';
import { writePidFile, removePidFile } from './pid.ts';
import { MessageQueue } from './message-queue.ts';
import { ChannelRunner } from './channel-runner.ts';
import { PluginManager } from '../plugins/plugin-manager.ts';
import { TaskScheduler } from './task-scheduler.ts';

function log(msg: string): void {
  process.stderr.write(`[daemon] ${msg}\n`);
}

function emit(event: DaemonEvent): void {
  process.stdout.write(formatMessage(event));
}

async function main(): Promise<void> {
  const configDir = process.env.KATA_CONFIG_DIR || join(homedir(), '.kata-agents');

  writePidFile(configDir, process.pid);
  log(`Starting (pid=${process.pid}, configDir=${configDir})`);

  emit({ type: 'status_changed', status: 'starting' });

  const dbPath = join(configDir, 'daemon.db');
  const queue = new MessageQueue(dbPath);
  log(`MessageQueue initialized at ${dbPath}`);

  const scheduler = new TaskScheduler(queue.getDb(), async (task) => {
    log(`Task ${task.id} fired (${task.type}): ${JSON.stringify(task.action)}`);
    emit({ type: 'task_fired', taskId: task.id, workspaceId: task.workspaceId });
  }, log);
  scheduler.start();
  log('TaskScheduler started');

  const state = {
    channelRunner: null as ChannelRunner | null,
    pluginManager: null as PluginManager | null,
  };

  emit({ type: 'status_changed', status: 'running' });

  // Read commands from stdin as JSON-lines
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let running = true;

  const pendingCommands: DaemonCommand[] = [];

  const parser = createLineParser((line: string) => {
    try {
      pendingCommands.push(JSON.parse(line) as DaemonCommand);
    } catch {
      log(`Failed to parse command: ${line}`);
    }
  });

  async function handleCommand(cmd: DaemonCommand): Promise<void> {
    try {
      switch (cmd.type) {
        case 'stop':
          log('Received stop command');
          running = false;
          break;
        case 'health_check':
          emit({ type: 'status_changed', status: 'running' });
          break;
        case 'start':
          // No-op: already running
          break;
        case 'plugin_action':
          log(`Plugin action: ${cmd.pluginId}/${cmd.action}`);
          // Future: route to specific plugin via PluginManager
          break;
        case 'configure_channels': {
          log(`Configuring channels for ${cmd.workspaces.length} workspace(s)`);
          // Stop existing runner and plugins if any
          if (state.channelRunner) {
            await state.channelRunner.stopAll();
            state.channelRunner = null;
          }
          if (state.pluginManager) {
            await state.pluginManager.shutdownAll();
            state.pluginManager = null;
          }
          // Collect enabled plugins (union across workspaces)
          const enabledPluginIds = new Set<string>();
          for (const ws of cmd.workspaces) {
            for (const pid of ws.enabledPlugins) {
              enabledPluginIds.add(pid);
            }
          }
          // Create and initialize plugin manager
          state.pluginManager = new PluginManager([...enabledPluginIds]);
          state.pluginManager.loadBuiltinPlugins();
          log(`PluginManager loaded with ${enabledPluginIds.size} enabled plugin(s)`);
          // Build workspace configs map
          const workspaceConfigs = new Map<
            string,
            { workspaceId: string; configs: ChannelConfig[]; tokens: Map<string, string> }
          >();
          for (const ws of cmd.workspaces) {
            workspaceConfigs.set(ws.workspaceId, {
              workspaceId: ws.workspaceId,
              configs: ws.configs as ChannelConfig[],
              tokens: new Map(Object.entries(ws.tokens)),
            });
          }
          state.channelRunner = new ChannelRunner(
            queue, emit, workspaceConfigs, log,
            state.pluginManager.getAdapterFactory(),
          );
          await state.channelRunner.startAll();
          break;
        }
        case 'schedule_task': {
          const task = scheduler.addTask({
            workspaceId: cmd.workspaceId,
            type: cmd.taskType as TaskType,
            schedule: cmd.schedule,
            action: cmd.action as TaskAction,
          });
          log(`Scheduled task ${task.id} (${task.type}): next at ${task.nextRunAt}`);
          break;
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Error handling command ${cmd.type}: ${errorMsg}`);
      emit({ type: 'plugin_error', pluginId: cmd.type, error: errorMsg });
    }
  }

  while (running) {
    const { value, done } = await reader.read();
    if (done) {
      log('stdin closed (parent exited)');
      break;
    }
    parser(decoder.decode(value, { stream: true }));

    while (pendingCommands.length > 0) {
      const cmd = pendingCommands.shift()!;
      await handleCommand(cmd);
    }
  }

  // Graceful shutdown
  emit({ type: 'status_changed', status: 'stopping' });
  await scheduler.stop();
  log('TaskScheduler stopped');
  if (state.pluginManager) {
    await state.pluginManager.shutdownAll();
    log('PluginManager shut down');
  }
  if (state.channelRunner) {
    await state.channelRunner.stopAll();
  }
  queue.close();
  log('MessageQueue closed');
  removePidFile(configDir);
  emit({ type: 'status_changed', status: 'stopped' });
  log('Shutdown complete');
}

main().catch((err) => {
  process.stderr.write(`[daemon] Fatal error: ${err}\n`);
  process.exit(1);
});
