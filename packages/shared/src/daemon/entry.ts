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
import type { DaemonCommand, DaemonEvent } from './types.ts';
import { createLineParser, formatMessage } from './ipc.ts';
import { writePidFile, removePidFile } from './pid.ts';
import { MessageQueue } from './message-queue.ts';

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

  emit({ type: 'status_changed', status: 'running' });

  // Read commands from stdin as JSON-lines
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let running = true;

  const parser = createLineParser((line: string) => {
    let cmd: DaemonCommand;
    try {
      cmd = JSON.parse(line) as DaemonCommand;
    } catch (err) {
      log(`Failed to parse command: ${line}`);
      return;
    }

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
        log(`Plugin action ignored (phase 13): ${cmd.pluginId}/${cmd.action}`);
        break;
    }
  });

  while (running) {
    const { value, done } = await reader.read();
    if (done) {
      log('stdin closed (parent exited)');
      break;
    }
    parser(decoder.decode(value, { stream: true }));
  }

  // Graceful shutdown
  emit({ type: 'status_changed', status: 'stopping' });
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
