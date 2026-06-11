import type { SessionMeta } from '../../shared/session-history-types'
import type { Store } from '../persistence'
import { loadKnownUsageWorktreesByRepo } from '../usage-worktree-metadata'
import { ClaudeSessionHistoryProvider } from './claude-session-history-provider'
import { buildSessionHistoryProjectScope } from './session-history-project-scope'
import type { SessionHistoryProvider } from './session-history-provider'

// Why: narrow seam — the service needs only these four Store capabilities,
// so tests can fake it without touching persistence or Electron.
export type SessionHistoryStore = Pick<
  Store,
  'getSettings' | 'onSettingsChanged' | 'getRepos' | 'getAllWorktreeMeta'
>

// Why poll, not fs.watch: the AR-9 accessor seam exposes no watch capability
// (a relay variant can't fs.watch) and NFR-1 bans watch storms; unchanged
// files rescan stat-only via the provider cache, so polling is cheap.
export const SESSION_HISTORY_POLL_INTERVAL_MS = 45_000

export class SessionHistoryService {
  private readonly store: SessionHistoryStore
  private readonly provider: SessionHistoryProvider
  private readonly pollIntervalMs: number
  private readonly changedListeners = new Set<() => void>()
  private cachedResult: SessionMeta[] | null = null
  private lastFingerprint: string | null = null
  private lastScanCompletedAt = 0
  private scanPromise: Promise<SessionMeta[]> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private unsubscribeSettings: (() => void) | null = null

  constructor(
    store: SessionHistoryStore,
    provider: SessionHistoryProvider = new ClaudeSessionHistoryProvider(),
    options?: { pollIntervalMs?: number }
  ) {
    this.store = store
    this.provider = provider
    this.pollIntervalMs = options?.pollIntervalMs ?? SESSION_HISTORY_POLL_INTERVAL_MS
  }

  async list(): Promise<SessionMeta[]> {
    // Why: AR-8 — the enable gate lives at the service entry, so disabled
    // means zero filesystem work, not merely hidden UI.
    if (!this.isEnabled()) {
      return []
    }
    if (this.cachedResult && Date.now() - this.lastScanCompletedAt < this.pollIntervalMs) {
      return this.cachedResult
    }
    return this.scan()
  }

  onChanged(listener: () => void): () => void {
    this.changedListeners.add(listener)
    return () => {
      this.changedListeners.delete(listener)
    }
  }

  start(): void {
    if (this.unsubscribeSettings) {
      return
    }
    // Why: only flips arriving with notifyListeners (the settings:set IPC
    // path) reach this — exactly the path the 1.5 Settings toggle uses.
    this.unsubscribeSettings = this.store.onSettingsChanged((updates) => {
      if (!('sessionHistoryEnabled' in updates)) {
        return
      }
      if (updates.sessionHistoryEnabled === true) {
        this.startPolling()
        // Flip-on emits once after the scan so an open UI refetches fresh data.
        void this.scan().then(() => this.notifyChanged())
      } else {
        this.stopPolling()
        this.cachedResult = null
        this.lastFingerprint = null
        this.lastScanCompletedAt = 0
        // Flip-off emits so an open UI refetches and empties.
        this.notifyChanged()
      }
    })
    if (this.isEnabled()) {
      this.startPolling()
    }
  }

  stop(): void {
    this.stopPolling()
    this.unsubscribeSettings?.()
    this.unsubscribeSettings = null
  }

  private isEnabled(): boolean {
    return this.store.getSettings().sessionHistoryEnabled === true
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return
    }
    this.pollTimer = setInterval(() => {
      void this.scan()
    }, this.pollIntervalMs)
    this.pollTimer.unref()
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // Single-flight: concurrent list()/poll ticks share one in-flight scan
  // (ClaudeUsageStore.runScan precedent).
  private scan(): Promise<SessionMeta[]> {
    if (this.scanPromise) {
      return this.scanPromise
    }
    this.scanPromise = (async () => {
      try {
        const repos = this.store.getRepos()
        // Scope is rebuilt per scan so repo/worktree changes are never stale.
        const scope = buildSessionHistoryProjectScope(
          repos,
          loadKnownUsageWorktreesByRepo(this.store, repos),
          this.store.getSettings()
        )
        const result = await this.provider.listSessions(scope)
        // Why: gate re-checked at completion — a disable flip mid-flight must
        // not resurrect results the flip handler already cleared.
        if (!this.isEnabled()) {
          return []
        }
        const fingerprint = fingerprintSessions(result)
        const changed = this.lastFingerprint !== null && fingerprint !== this.lastFingerprint
        this.cachedResult = result
        this.lastFingerprint = fingerprint
        this.lastScanCompletedAt = Date.now()
        if (changed) {
          this.notifyChanged()
        }
        return result
      } catch (error) {
        // Why: quiet non-fatal breadcrumb (UX-DR6, 1.2-deferred diagnostic) —
        // state stays at last-good, never a throw, never UI surface.
        console.debug('[session-history] scan failed:', error)
        return this.cachedResult ?? []
      } finally {
        this.scanPromise = null
      }
    })()
    return this.scanPromise
  }

  private notifyChanged(): void {
    for (const listener of this.changedListeners) {
      try {
        listener()
      } catch (error) {
        console.debug('[session-history] changed listener failed:', error)
      }
    }
  }
}

function fingerprintSessions(sessions: readonly SessionMeta[]): string {
  // Why: stable change signal for the IPC push. The provider already sorts by
  // lastActivity desc, so row order is meaningful — don't re-sort here.
  return JSON.stringify(
    sessions.map((session) => [
      session.sessionId,
      session.lastActivity,
      session.title,
      session.titleSource,
      session.isLive,
      session.repoId,
      session.worktreeId
    ])
  )
}
