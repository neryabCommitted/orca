import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { SessionMeta } from '../../../../shared/session-history-types'

export type SessionHistorySlice = {
  sessionHistorySessions: SessionMeta[]
  sessionHistoryLoaded: boolean
  fetchSessionHistory: () => Promise<void>
}

export const createSessionHistorySlice: StateCreator<AppState, [], [], SessionHistorySlice> = (
  set
) => ({
  sessionHistorySessions: [],
  sessionHistoryLoaded: false,

  fetchSessionHistory: async () => {
    try {
      const sessions = await window.api.sessionHistory.list()
      set({ sessionHistorySessions: sessions, sessionHistoryLoaded: true })
    } catch (err) {
      // Why: UX-DR6 pins silent failure — keep last-good sessions, never
      // surface an error into the sidebar.
      console.warn('[session-history] list failed:', err)
    }
  }
})
