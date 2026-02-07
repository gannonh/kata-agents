/**
 * SQLite Message Queue
 *
 * Durable message queue backed by bun:sqlite with WAL mode.
 * Supports enqueue, atomic dequeue, and status transitions.
 */

import { Database } from 'bun:sqlite';
import type { MessageDirection, QueuedMessage } from './types.ts';

/**
 * SQLite-backed message queue for the daemon subprocess.
 * Uses WAL mode for concurrent read safety and prepared statements for performance.
 */
export class MessageQueue {
  private db: Database;

  constructor(_dbPath: string) {
    this.db = null as unknown as Database;
    throw new Error('Not implemented');
  }

  enqueue(_direction: MessageDirection, _channelId: string, _payload: unknown): number {
    throw new Error('Not implemented');
  }

  dequeue(_direction: MessageDirection): QueuedMessage | null {
    throw new Error('Not implemented');
  }

  markProcessed(_id: number): void {
    throw new Error('Not implemented');
  }

  markFailed(_id: number, _error: string): void {
    throw new Error('Not implemented');
  }

  close(): void {
    throw new Error('Not implemented');
  }
}
