import { basename } from 'path'
import type {
  SessionHistoryProjectScope,
  SessionHistoryScopeRoot,
  SessionMeta,
  TranscriptModel
} from '../../shared/session-history-types'
import {
  canonicalizePath,
  findContainingWorktree,
  normalizeComparablePath
} from '../claude-store/claude-store-paths'
import { scanFilesInBatches } from '../claude-store/claude-store-scan'
import {
  createLocalClaudeStoreFsAccessor,
  type ClaudeStoreFsAccessor
} from './claude-store-fs-accessor'
import {
  deriveSessionTitle,
  extractSessionFileMetadata,
  type SessionFileMetadata
} from './claude-transcript-parser'
import { isFilesystemRootPath } from './session-history-project-scope'
import type { SessionHistoryProvider } from './session-history-provider'

// Why: the cache holds the extracted (already length-capped) metadata, not a
// composed title — the fallback tier embeds lastActivity, which is mtime-
// derived and only changes when the cache misses anyway.
type CachedSessionFileMetadata = {
  mtimeMs: number
  size: number
  metadata: SessionFileMetadata
}

export class ClaudeSessionHistoryProvider implements SessionHistoryProvider {
  private readonly accessor: ClaudeStoreFsAccessor
  // Why: AR-5/AR-14 — an unchanged file pays stat-only on rescan, and keys
  // are post-realpath so symlinked store paths share one cache entry.
  private readonly fileMetadataCache = new Map<string, CachedSessionFileMetadata>()

  constructor(accessor: ClaudeStoreFsAccessor = createLocalClaudeStoreFsAccessor()) {
    this.accessor = accessor
  }

  async listSessions(scope: SessionHistoryProjectScope): Promise<SessionMeta[]> {
    const lookup = new Map<string, SessionHistoryScopeRoot>()
    for (const root of scope.roots) {
      // Why: key both the literal and realpath forms, first-wins — a deleted
      // cwd canonicalizes via the literal fallback yet must match a symlinked
      // root, and builder order (live worktrees first) must survive realpath
      // collisions. A key resolving to the filesystem root would contain
      // every path (isContainedPath quirk) — never registered.
      for (const key of new Set([
        normalizeComparablePath(root.path),
        await canonicalizePath(root.path)
      ])) {
        if (!isFilesystemRootPath(key) && !lookup.has(key)) {
          lookup.set(key, root)
        }
      }
    }

    let files: string[] = []
    try {
      files = await this.accessor.listSessionFiles()
    } catch {
      // Why: discovery must never throw into the caller (FR-4/NFR-5).
      return []
    }

    const canonicalCwdByPath = new Map<string, string>()
    const bySessionId = new Map<string, SessionMeta>()
    const seenCacheKeys = new Set<string>()

    await scanFilesInBatches(
      files,
      (filePath) => this.readSessionMeta(filePath, lookup, canonicalCwdByPath, seenCacheKeys),
      (meta) => {
        if (!meta) {
          return
        }
        // Why: a resumed session appears in multiple files (the scanner's
        // mergeClaudeSessions precedent) — keep the most recent entry.
        const existing = bySessionId.get(meta.sessionId)
        if (!existing || meta.lastActivity > existing.lastActivity) {
          bySessionId.set(meta.sessionId, meta)
        }
      }
    )

    // Why: files deleted from the store would otherwise pin their cache
    // entries forever in a long-lived provider instance.
    for (const key of this.fileMetadataCache.keys()) {
      if (!seenCacheKeys.has(key)) {
        this.fileMetadataCache.delete(key)
      }
    }

    return [...bySessionId.values()].sort((left, right) =>
      right.lastActivity.localeCompare(left.lastActivity)
    )
  }

  // Why: transcript parsing is Story 2.1; the typed stub keeps the provider
  // interface complete without implementing ahead of the PR slicing.
  async readTranscript(_sessionId: string): Promise<TranscriptModel> {
    return { turns: [], schemaRecognized: false }
  }

  private async readSessionMeta(
    filePath: string,
    lookup: Map<string, SessionHistoryScopeRoot>,
    canonicalCwdByPath: Map<string, string>,
    seenCacheKeys: Set<string>
  ): Promise<SessionMeta | null> {
    try {
      const cacheKey = await canonicalizePath(filePath)
      seenCacheKeys.add(cacheKey)
      const fileStat = await this.accessor.statFile(filePath)
      const cached = this.fileMetadataCache.get(cacheKey)

      let metadata: SessionFileMetadata
      if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        metadata = cached.metadata
      } else {
        metadata = await extractSessionFileMetadata(this.accessor.readLines(filePath))
        this.fileMetadataCache.set(cacheKey, {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          metadata
        })
      }

      // Why: a session with no attributable cwd never surfaces under an
      // unrelated Project — dropped at the provider layer (FR-5/AC-3).
      const cwd = metadata.cwd
      if (cwd === null) {
        return null
      }

      let canonicalCwd = canonicalCwdByPath.get(cwd)
      if (canonicalCwd === undefined) {
        // Why: many sessions share few unique cwds; cache realpath work so
        // attribution scales with unique paths (scanner memo precedent).
        canonicalCwd = await canonicalizePath(cwd)
        canonicalCwdByPath.set(cwd, canonicalCwd)
      }
      const root = findContainingWorktree(canonicalCwd, lookup)
      if (!root) {
        return null
      }

      const sessionId = basename(filePath, '.jsonl')
      const lastActivity = new Date(fileStat.mtimeMs).toISOString()
      const { title, titleSource } = deriveSessionTitle(metadata, lastActivity, sessionId)
      return {
        sessionId,
        title,
        titleSource,
        lastActivity,
        repoId: root.repoId,
        worktreeId: root.worktreeId,
        cwd,
        // Why: the live-session registry lands in Story 1.4.
        isLive: false
      }
    } catch {
      // Why: a file deleted or torn mid-scan (live Claude churn) skips that
      // file only — never breaks the whole listing (FR-4/NFR-3).
      return null
    }
  }
}
