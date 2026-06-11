import type { ClaudeStoreFsAccessor } from './claude-store-fs-accessor'

// Why: live records are ~300-byte single-line JSON; the bound keeps a corrupt
// or runaway file from ballooning memory before the parse rejects it (NFR-5).
const MAX_LIVE_RECORD_BYTES = 4096

// Why: a crashed Claude leaves its registry record behind; without a liveness
// probe that session would be hidden from the past list forever (AR-10).
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM ⇒ the process exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readLiveSessionIds(
  accessor: ClaudeStoreFsAccessor,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive
): Promise<Set<string>> {
  const liveIds = new Set<string>()
  let recordFiles: string[]
  try {
    recordFiles = await accessor.listLiveSessionFiles()
  } catch {
    return liveIds
  }
  for (const path of recordFiles) {
    // Per-record skip on any failure: one torn or hostile file must never
    // hide liveness derived from the healthy records (NFR-5).
    try {
      let raw = ''
      for await (const line of accessor.readLines(path)) {
        raw += line
        if (raw.length > MAX_LIVE_RECORD_BYTES) {
          break
        }
      }
      if (raw.length === 0 || raw.length > MAX_LIVE_RECORD_BYTES) {
        continue
      }
      const record = JSON.parse(raw) as { sessionId?: unknown; pid?: unknown }
      if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
        continue
      }
      if (typeof record.pid !== 'number') {
        continue
      }
      if (isPidAlive(record.pid)) {
        liveIds.add(record.sessionId)
      }
    } catch {
      continue
    }
  }
  return liveIds
}
