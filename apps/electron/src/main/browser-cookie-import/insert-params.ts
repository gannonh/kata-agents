export type ChromiumCookieColumnInfo = {
  name: string
  type?: string
  notnull?: number | bigint
  dflt_value?: unknown
}

function parseSqliteDefaultValue(raw: unknown, type: string): string | number | Buffer | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') {
    return typeof raw === 'number' || typeof raw === 'bigint' ? Number(raw) : String(raw)
  }
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toUpperCase() === 'NULL') return null
  if (/^X''$/i.test(trimmed) || type.includes('BLOB')) return Buffer.alloc(0)
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (type.includes('INT')) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : 0
  }
  return trimmed
}

function normalizeSqliteCookieValue(value: unknown): string | number | bigint | Buffer | null {
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value
  return String(value)
}

function isSqliteNotNull(column: ChromiumCookieColumnInfo): boolean {
  return Number(column.notnull ?? 0) !== 0
}

function fallbackChromiumCookieColumnValue(
  column: ChromiumCookieColumnInfo,
  sourceRow: Record<string, unknown>,
): string | number | bigint | Buffer | null {
  const type = (column.type ?? '').toUpperCase()
  const defaultValue = parseSqliteDefaultValue(column.dflt_value, type)
  if (defaultValue !== null) return defaultValue
  if (!isSqliteNotNull(column)) return null

  switch (column.name) {
    case 'value':
    case 'encrypted_value':
      return Buffer.alloc(0)
    case 'top_frame_site_key':
      return ''
    case 'source_port':
      return -1
    case 'last_update_utc':
      return normalizeSqliteCookieValue(sourceRow.creation_utc) ?? 0
    default:
      if (type.includes('BLOB')) return Buffer.alloc(0)
      if (type.includes('INT')) return 0
      return ''
  }
}

export function buildChromiumCookieInsertParams(
  targetColumns: ChromiumCookieColumnInfo[],
  sourceRow: Record<string, unknown>,
  decryptedValue: Buffer,
): (string | number | bigint | Buffer | null)[] {
  return targetColumns.map((column) => {
    if (column.name === 'encrypted_value') return Buffer.alloc(0)
    if (column.name === 'value') return decryptedValue

    const sourceHasColumn = Object.prototype.hasOwnProperty.call(sourceRow, column.name)
    const sourceValue = sourceHasColumn ? normalizeSqliteCookieValue(sourceRow[column.name]) : null
    if (sourceValue !== null) return sourceValue
    if (sourceHasColumn && !isSqliteNotNull(column)) return null
    return fallbackChromiumCookieColumnValue(column, sourceRow)
  })
}
