import type { SessionMetaTitleSource } from '../../shared/session-history-types'

// Why: AR-3 pins one shared prefix-scan cap for all metadata passes (Story 1.3
// extends this file with the title chain on the same budget).
export const SESSION_METADATA_SCAN_MAX_LINES = 200
export const SESSION_METADATA_SCAN_MAX_BYTES = 256 * 1024

// Why: NFR-8 — every title tier is single-line and length-capped at capture
// time so no raw message body ever reaches the cache, IPC, or sidebar.
export const SESSION_LABEL_MAX_CHARS = 80

export type SessionFileMetadata = {
  cwd: string | null
  firstTimestamp: string | null
  customTitle: string | null
  aiTitle: string | null
  firstUserMessage: string | null
}

function readStringField(record: unknown, field: string): string | null {
  if (typeof record !== 'object' || record === null) {
    return null
  }
  const value = (record as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readObjectField(record: unknown, field: string): Record<string, unknown> | null {
  if (typeof record !== 'object' || record === null) {
    return null
  }
  const value = (record as Record<string, unknown>)[field]
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export function normalizeSessionLabelText(raw: string): string | null {
  const collapsed = raw.replace(/[\s\p{Cc}]+/gu, ' ').trim()
  if (collapsed.length === 0) {
    return null
  }
  if (collapsed.length <= SESSION_LABEL_MAX_CHARS) {
    return collapsed
  }
  return `${collapsed.slice(0, SESSION_LABEL_MAX_CHARS)}…`
}

// Why: command/caveat records are slash-command plumbing, not something the
// user typed as a conversation opener (verified on-disk shapes).
const FIRST_MESSAGE_NOISE_PREFIXES = ['<command-', '<local-command-caveat>']

function readUserMessageText(record: unknown): string | null {
  const meta = record as Record<string, unknown>
  if (meta.isMeta === true || meta.isSidechain === true) {
    return null
  }
  const message = readObjectField(record, 'message')
  if (message === null || message.role !== 'user') {
    return null
  }
  const content = message.content
  let text: string | null = null
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    // Why: image-paste prompts arrive as content arrays — take the first text
    // part; tool_result-only arrays yield nothing.
    const part = content.find((p) => readStringField(p, 'type') === 'text')
    text = part === undefined ? null : readStringField(part, 'text')
  }
  if (text === null) {
    return null
  }
  const trimmed = text.trim()
  if (
    trimmed.length === 0 ||
    FIRST_MESSAGE_NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  ) {
    return null
  }
  return trimmed
}

export async function extractSessionFileMetadata(
  lines: AsyncIterable<string>
): Promise<SessionFileMetadata> {
  let cwd: string | null = null
  let firstTimestamp: string | null = null
  let customTitle: string | null = null
  let aiTitle: string | null = null
  let firstUserMessage: string | null = null
  let lineCount = 0
  let byteCount = 0

  for await (const line of lines) {
    lineCount++
    // Why: the byte budget excludes the cap-crossing line itself — a single
    // oversized prelude record (file-history-snapshot) must still be parsed
    // or its session loses cwd and vanishes from history.
    if (
      lineCount > SESSION_METADATA_SCAN_MAX_LINES ||
      byteCount > SESSION_METADATA_SCAN_MAX_BYTES
    ) {
      break
    }
    byteCount += Buffer.byteLength(line, 'utf-8')

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

    // Why: rename/title regeneration appends new records, so last-within-cap
    // wins for both title tiers (AR-3) — no early exit once cwd is known.
    const recordType = readStringField(record, 'type')
    if (recordType === 'custom-title') {
      customTitle =
        normalizeSessionLabelText(readStringField(record, 'customTitle') ?? '') ?? customTitle
    } else if (recordType === 'ai-title') {
      aiTitle = normalizeSessionLabelText(readStringField(record, 'aiTitle') ?? '') ?? aiTitle
    } else if (firstUserMessage === null && recordType === 'user') {
      firstUserMessage = normalizeSessionLabelText(readUserMessageText(record) ?? '')
    }
  }

  return { cwd, firstTimestamp, customTitle, aiTitle, firstUserMessage }
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

// Why: UX-DR4 pins the precedence — /rename beats AI title beats first
// message beats fallback — and the chain must never yield a blank row.
export function deriveSessionTitle(
  metadata: SessionFileMetadata,
  lastActivity: string,
  sessionId: string
): { title: string; titleSource: SessionMetaTitleSource } {
  if (metadata.customTitle !== null) {
    return { title: metadata.customTitle, titleSource: 'userRename' }
  }
  if (metadata.aiTitle !== null) {
    return { title: metadata.aiTitle, titleSource: 'aiTitle' }
  }
  if (metadata.firstUserMessage !== null) {
    return { title: metadata.firstUserMessage, titleSource: 'firstMessage' }
  }
  return { title: buildFallbackSessionLabel(lastActivity, sessionId), titleSource: 'fallback' }
}

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
