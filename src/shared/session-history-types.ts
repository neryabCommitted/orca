// Why: provider-neutral session-history contracts (AR-11). No fs imports —
// shared code is consumed by main and renderer typecheck targets alike.

export type SessionMetaTitleSource = 'aiTitle' | 'firstMessage' | 'fallback'

export type SessionMeta = {
  sessionId: string
  title: string
  titleSource: SessionMetaTitleSource
  /** ISO 8601 timestamp of the most recent activity in the session. */
  lastActivity: string
  repoId: string | null
  worktreeId: string | null
  cwd: string | null
  isLive: boolean
}

export type TranscriptTurnRole = 'user' | 'assistant' | 'system' | 'tool'

export type TranscriptTurn = {
  role: TranscriptTurnRole
  content: string
  timestamp?: string
}

export type TranscriptModel = {
  turns: TranscriptTurn[]
  schemaRecognized: boolean
}

export type SessionHistoryScopeRoot = {
  path: string
  repoId: string
  /** null marks a repo-level root (e.g. a nested workspace-layout dir) rather than a live worktree. */
  worktreeId: string | null
}

export type SessionHistoryProjectScope = {
  roots: SessionHistoryScopeRoot[]
}
