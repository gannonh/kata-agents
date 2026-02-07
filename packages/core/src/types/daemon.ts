/**
 * Daemon Types
 *
 * Types for the always-on daemon process that runs channel adapters and plugins.
 * Used for IPC communication between the Electron main process and the daemon subprocess.
 */

/**
 * Lifecycle status of the daemon process.
 */
export type DaemonStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * Commands sent from the Electron main process to the daemon.
 * Discriminated union on the `type` field.
 */
export type DaemonCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'health_check' }
  | {
      type: 'plugin_action';
      /** Target plugin identifier */
      pluginId: string;
      /** Action name within the plugin */
      action: string;
      /** Optional action payload */
      payload?: unknown;
    };

/**
 * Events emitted by the daemon to the Electron main process.
 * Discriminated union on the `type` field.
 */
export type DaemonEvent =
  | {
      type: 'status_changed';
      /** New daemon status */
      status: DaemonStatus;
      /** Error message when status is 'error' */
      error?: string;
    }
  | {
      type: 'message_received';
      /** Channel that received the message */
      channelId: string;
      /** ID of the received message */
      messageId: string;
    }
  | {
      type: 'message_sent';
      /** Channel the message was sent through */
      channelId: string;
      /** ID of the sent message */
      messageId: string;
    }
  | {
      type: 'plugin_loaded';
      /** Plugin that was loaded */
      pluginId: string;
    }
  | {
      type: 'plugin_error';
      /** Plugin that encountered an error */
      pluginId: string;
      /** Error description */
      error: string;
    };
