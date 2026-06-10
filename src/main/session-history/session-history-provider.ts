import type {
  SessionHistoryProjectScope,
  SessionMeta,
  TranscriptModel
} from '../../shared/session-history-types'

// Why: minimal seam (AR-2) — list metadata and read one transcript, nothing
// else. Provider-specific store concepts must stay behind implementations.
export type SessionHistoryProvider = {
  listSessions(projectScope: SessionHistoryProjectScope): Promise<SessionMeta[]>
  readTranscript(sessionId: string): Promise<TranscriptModel>
}
