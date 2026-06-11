import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../shared/types'
import type {
  SessionHistoryProjectScope,
  SessionMeta,
  TranscriptModel
} from '../../shared/session-history-types'
import type { SessionHistoryProvider } from './session-history-provider'
import {
  SESSION_HISTORY_POLL_INTERVAL_MS,
  SessionHistoryService,
  type SessionHistoryStore
} from './session-history-service'

function makeMeta(sessionId: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    title: `Session ${sessionId}`,
    titleSource: 'firstMessage',
    lastActivity: '2026-06-09T10:00:00.000Z',
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    cwd: '/ws/repo-a',
    isLive: false,
    ...overrides
  }
}

type SettingsListener = (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void

function makeFakeStore(initial: { enabled: boolean; repos?: Repo[] }) {
  let settings = {
    sessionHistoryEnabled: initial.enabled,
    sessionHistoryShownCount: 5,
    workspaceDir: '/ws',
    nestWorkspaces: false
  } as GlobalSettings
  let repos = initial.repos ?? []
  const listeners = new Set<SettingsListener>()
  const store: SessionHistoryStore = {
    getSettings: () => settings,
    onSettingsChanged: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getRepos: () => repos,
    getAllWorktreeMeta: () => ({})
  }
  return {
    store,
    setRepos(next: Repo[]) {
      repos = next
    },
    // Mirrors the settings:set path: merge, then notify with changed keys.
    applySettings(updates: Partial<GlobalSettings>) {
      settings = { ...settings, ...updates }
      for (const listener of listeners) {
        listener(updates, settings)
      }
    }
  }
}

// No SessionHistoryProvider annotation: it would widen listSessions to the
// plain function type and hide the Mock methods from the type checker.
function makeFakeProvider(initialResult: SessionMeta[] = []) {
  let result = initialResult
  return {
    listSessions: vi.fn(async (_scope: SessionHistoryProjectScope) => result),
    readTranscript: vi.fn(
      async (): Promise<TranscriptModel> => ({ turns: [], schemaRecognized: false })
    ),
    get result() {
      return result
    },
    set result(next: SessionMeta[]) {
      result = next
    }
  }
}

let services: SessionHistoryService[]

function makeService(
  store: SessionHistoryStore,
  provider: SessionHistoryProvider
): SessionHistoryService {
  const service = new SessionHistoryService(store, provider)
  services.push(service)
  return service
}

beforeEach(() => {
  vi.useFakeTimers()
  services = []
})

afterEach(() => {
  for (const service of services) {
    service.stop()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SessionHistoryService gate', () => {
  it('returns [] without any provider call while disabled', async () => {
    const { store } = makeFakeStore({ enabled: false })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(store, provider)

    await expect(service.list()).resolves.toEqual([])
    expect(provider.listSessions).not.toHaveBeenCalled()
  })

  it('does not run the poll timer while disabled', async () => {
    const { store } = makeFakeStore({ enabled: false })
    const provider = makeFakeProvider()
    const service = makeService(store, provider)
    service.start()

    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS * 3)
    expect(provider.listSessions).not.toHaveBeenCalled()
  })

  it('returns the provider result when enabled', async () => {
    const { store } = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a'), makeMeta('b')])
    const service = makeService(store, provider)

    await expect(service.list()).resolves.toEqual([makeMeta('a'), makeMeta('b')])
    expect(provider.listSessions).toHaveBeenCalledTimes(1)
  })
})

describe('SessionHistoryService caching and single-flight', () => {
  it('serves the cached result within the staleness window (1 scan for 2 quick lists)', async () => {
    const { store } = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(store, provider)

    await service.list()
    await service.list()
    expect(provider.listSessions).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS + 1_000)
    // The poll tick already rescanned; a list right after serves that cache.
    await service.list()
    expect(provider.listSessions).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight scan between concurrent lists', async () => {
    const { store } = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider()
    let resolveScan: (value: SessionMeta[]) => void = () => {}
    provider.listSessions.mockImplementationOnce(
      () =>
        new Promise<SessionMeta[]>((resolve) => {
          resolveScan = resolve
        })
    )
    const service = makeService(store, provider)

    const first = service.list()
    const second = service.list()
    resolveScan([makeMeta('a')])
    await expect(first).resolves.toEqual([makeMeta('a')])
    await expect(second).resolves.toEqual([makeMeta('a')])
    expect(provider.listSessions).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the project scope on every scan (no stale scope caching)', async () => {
    const repoA = { id: 'repo-1', path: '/ws/repo-a', displayName: 'Repo A' } as Repo
    const repoB = { id: 'repo-2', path: '/ws/repo-b', displayName: 'Repo B' } as Repo
    const fake = makeFakeStore({ enabled: true, repos: [repoA] })
    const provider = makeFakeProvider()
    const service = makeService(fake.store, provider)

    await service.list()
    fake.setRepos([repoA, repoB])
    // Step past the staleness window so the next list() rescans.
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS + 1_000)
    await service.list()

    expect(provider.listSessions).toHaveBeenCalledTimes(2)
    const firstScope = provider.listSessions.mock.calls[0][0]
    const secondScope = provider.listSessions.mock.calls[1][0]
    expect(firstScope.roots.map((root) => root.repoId)).toEqual(['repo-1'])
    expect(secondScope.roots.map((root) => root.repoId)).toEqual(['repo-1', 'repo-2'])
  })
})

describe('SessionHistoryService change detection and poll', () => {
  it('emits onChanged only when a rescan fingerprint differs', async () => {
    const { store } = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(store, provider)
    const listener = vi.fn()
    service.onChanged(listener)
    service.start()

    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    expect(listener).not.toHaveBeenCalled()

    // Identical rescan → no emit.
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    expect(listener).not.toHaveBeenCalled()

    provider.result = [makeMeta('a'), makeMeta('b')]
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('emits when only a title changes (rename) for the same session set', async () => {
    const { store } = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(store, provider)
    const listener = vi.fn()
    service.onChanged(listener)
    service.start()

    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    provider.result = [makeMeta('a', { title: 'Renamed', titleSource: 'userRename' })]
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps notifying the remaining listeners when one throws', async () => {
    const { store } = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(store, provider)
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const throwing = vi.fn(() => {
      throw new Error('listener boom')
    })
    const healthy = vi.fn()
    service.onChanged(throwing)
    service.onChanged(healthy)
    service.start()

    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    provider.result = [makeMeta('a'), makeMeta('b')]
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)

    expect(throwing).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(debugSpy).toHaveBeenCalled()
  })

  it('keeps the last-good result and logs a breadcrumb when the provider throws', async () => {
    const { store } = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(store, provider)
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    await expect(service.list()).resolves.toEqual([makeMeta('a')])

    provider.listSessions.mockRejectedValueOnce(new Error('scan boom'))
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS + 1_000)
    await expect(service.list()).resolves.toEqual([makeMeta('a')])
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('[session-history]'),
      expect.any(Error)
    )
  })
})

describe('SessionHistoryService enable/disable flips', () => {
  it('starts polling, scans, and emits when the setting flips on', async () => {
    const fake = makeFakeStore({ enabled: false })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(fake.store, provider)
    const listener = vi.fn()
    service.onChanged(listener)
    service.start()

    fake.applySettings({ sessionHistoryEnabled: true })
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.listSessions).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    await expect(service.list()).resolves.toEqual([makeMeta('a')])

    provider.result = [makeMeta('a'), makeMeta('b')]
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops the timer, clears state, and emits when the setting flips off', async () => {
    const fake = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(fake.store, provider)
    const listener = vi.fn()
    service.onChanged(listener)
    service.start()

    await service.list()
    expect(provider.listSessions).toHaveBeenCalledTimes(1)

    fake.applySettings({ sessionHistoryEnabled: false })
    expect(listener).toHaveBeenCalledTimes(1)

    await expect(service.list()).resolves.toEqual([])
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS * 3)
    expect(provider.listSessions).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight scan result when disabled mid-flight', async () => {
    const fake = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider()
    let resolveScan: (value: SessionMeta[]) => void = () => {}
    provider.listSessions.mockImplementationOnce(
      () =>
        new Promise<SessionMeta[]>((resolve) => {
          resolveScan = resolve
        })
    )
    const service = makeService(fake.store, provider)
    service.start()

    const inFlight = service.list()
    fake.applySettings({ sessionHistoryEnabled: false })
    resolveScan([makeMeta('a')])
    await expect(inFlight).resolves.toEqual([])

    // Re-enable must not serve the discarded mid-flight result from cache —
    // the flip-on scan sees the provider's current state instead.
    provider.result = [makeMeta('b')]
    fake.applySettings({ sessionHistoryEnabled: true })
    await vi.advanceTimersByTimeAsync(0)
    await expect(service.list()).resolves.toEqual([makeMeta('b')])
  })

  it('start() is idempotent and stop() unsubscribes', async () => {
    const fake = makeFakeStore({ enabled: true })
    const provider = makeFakeProvider([makeMeta('a')])
    const service = makeService(fake.store, provider)
    service.start()
    service.start()

    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS)
    expect(provider.listSessions).toHaveBeenCalledTimes(1)

    service.stop()
    await vi.advanceTimersByTimeAsync(SESSION_HISTORY_POLL_INTERVAL_MS * 3)
    expect(provider.listSessions).toHaveBeenCalledTimes(1)

    const listener = vi.fn()
    service.onChanged(listener)
    fake.applySettings({ sessionHistoryEnabled: false })
    expect(listener).not.toHaveBeenCalled()
  })
})
