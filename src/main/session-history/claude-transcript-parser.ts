// Why: AR-3 pins one shared prefix-scan cap for all metadata passes (Story 1.3
// extends this file with the title chain on the same budget).
export const SESSION_METADATA_SCAN_MAX_LINES = 200
export const SESSION_METADATA_SCAN_MAX_BYTES = 256 * 1024

export type SessionFileMetadata = {
  cwd: string | null
  firstTimestamp: string | null
}

function readStringField(record: unknown, field: string): string | null {
  if (typeof record !== 'object' || record === null) {
    return null
  }
  const value = (record as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export async function extractSessionFileMetadata(
  lines: AsyncIterable<string>
): Promise<SessionFileMetadata> {
  let cwd: string | null = null
  let firstTimestamp: string | null = null
  let lineCount = 0
  let byteCount = 0

  for await (const line of lines) {
    lineCount++
    byteCount += Buffer.byteLength(line, 'utf-8')
    if (
      lineCount > SESSION_METADATA_SCAN_MAX_LINES ||
      byteCount > SESSION_METADATA_SCAN_MAX_BYTES
    ) {
      break
    }

    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      // Why: live Claude appends can tear the trailing line; a bad record is
      // skipped, never fatal (NFR-3).
      continue
    }

    cwd ??= readStringField(record, 'cwd')
    firstTimestamp ??= readStringField(record, 'timestamp')
    if (cwd !== null && firstTimestamp !== null) {
      break
    }
  }

  return { cwd, firstTimestamp }
}

// Why: label text must not vary with the OS locale — fixed English month
// names keep snapshots and cross-platform UI stable.
const FALLBACK_LABEL_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

export function buildFallbackSessionLabel(lastActivity: string, sessionId: string): string {
  const shortId = sessionId.slice(0, 8)
  const parsed = new Date(lastActivity)
  if (Number.isNaN(parsed.getTime())) {
    return shortId || 'session'
  }
  const month = FALLBACK_LABEL_MONTHS[parsed.getMonth()]
  const hours = String(parsed.getHours()).padStart(2, '0')
  const minutes = String(parsed.getMinutes()).padStart(2, '0')
  const datePart = `${month} ${parsed.getDate()}, ${hours}:${minutes}`
  return shortId ? `${datePart} · ${shortId}` : datePart
}
