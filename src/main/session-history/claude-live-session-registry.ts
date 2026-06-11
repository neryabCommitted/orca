import type { ClaudeStoreFsAccessor } from './claude-store-fs-accessor'

// Why: post-read rejection cap (UTF-16 code units, not bytes) — readline
// buffers a whole line before this check runs, so it rejects oversized records
// rather than bounding the read; a true byte-capped read is parked in deferred-work.md.
const MAX_LIVE_RECORD_LENGTH = 4096

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
        if (raw.length > MAX_LIVE_RECORD_LENGTH) {
          break
        }
      }
      if (raw.length === 0 || raw.length > MAX_LIVE_RECORD_LENGTH) {
        continue
      }
      const record = JSON.parse(raw) as { sessionId?: unknown; pid?: unknown }
      if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
        continue
      }
      // Why: pid 0 / negatives signal process groups — process.kill(0, 0)
      // always "succeeds", so probing them would mark corrupt records live forever.
      if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
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
