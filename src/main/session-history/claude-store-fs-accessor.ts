import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import {
  listClaudeLiveSessionRecordFiles,
  listClaudeProjectSessionFiles
} from '../claude-store/claude-store-discovery'
import { getProcessedFileStat, type ScannedFileStat } from '../claude-store/claude-store-scan'

// Why: AR-9 seam — the Claude provider sees only these read operations, so an
// SSH-relay variant can slot in without touching the provider. Read-only by
// construction: the interface exposes no write capability (NFR-2).
export type ClaudeStoreFsAccessor = {
  listSessionFiles(): Promise<string[]>
  listLiveSessionFiles(): Promise<string[]>
  statFile(path: string): Promise<ScannedFileStat>
  readLines(path: string): AsyncIterable<string>
}

export function createLocalClaudeStoreFsAccessor(): ClaudeStoreFsAccessor {
  return {
    listSessionFiles: () => listClaudeProjectSessionFiles(),
    listLiveSessionFiles: () => listClaudeLiveSessionRecordFiles(),
    statFile: (path) => getProcessedFileStat(path),
    readLines: (path) =>
      createInterface({
        input: createReadStream(path, { encoding: 'utf-8' }),
        crlfDelay: Infinity
      })
  }
}
