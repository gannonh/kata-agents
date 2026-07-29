/**
 * Shared, pure Git helpers usable across renderer and server.
 *
 * Currently the diff-line comment model for the Changes review flow. Keep this
 * module free of React and transport concerns so it stays unit-testable.
 */
export * from './comments'
export * from './status-summary'
