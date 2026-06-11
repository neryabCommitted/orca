import { create } from 'zustand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionHistorySlice } from './session-history'
import type { AppState } from '../types'
import type { SessionMeta } from '../../../../shared/session-history-types'

function makeSessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: 'session-1',
    title: 'Fix the flaky test',
    titleSource: 'firstMessage',
    lastActivity: '2026-06-11T10:00:00.000Z',
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/repo',
    isLive: false,
    ...overrides
  }
}

function makeStore() {
  return create<
    Pick<AppState, 'sessionHistorySessions' | 'sessionHistoryLoaded' | 'fetchSessionHistory'>
  >()((...args) =>
    createSessionHistorySlice(...(args as Parameters<typeof createSessionHistorySlice>))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createSessionHistorySlice', () => {
  it('populates sessions and flips loaded on a successful fetch', async () => {
    const sessions = [makeSessionMeta(), makeSessionMeta({ sessionId: 'session-2' })]
    const list = vi.fn().mockResolvedValue(sessions)
    vi.stubGlobal('window', { api: { sessionHistory: { list } } })

    const store = makeStore()
    expect(store.getState().sessionHistorySessions).toEqual([])
    expect(store.getState().sessionHistoryLoaded).toBe(false)

    await store.getState().fetchSessionHistory()

    expect(list).toHaveBeenCalledTimes(1)
    expect(store.getState().sessionHistorySessions).toEqual(sessions)
    expect(store.getState().sessionHistoryLoaded).toBe(true)
  })

  it('keeps last-good sessions and loaded flag on a rejected fetch, without throwing', async () => {
    const sessions = [makeSessionMeta()]
    const list = vi
      .fn()
      .mockResolvedValueOnce(sessions)
      .mockRejectedValueOnce(new Error('ipc down'))
    vi.stubGlobal('window', { api: { sessionHistory: { list } } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = makeStore()
    await store.getState().fetchSessionHistory()
    await expect(store.getState().fetchSessionHistory()).resolves.toBeUndefined()

    expect(store.getState().sessionHistorySessions).toEqual(sessions)
    expect(store.getState().sessionHistoryLoaded).toBe(true)
    expect(warn).toHaveBeenCalled()
  })
})
