import { BrowserWindow, ipcMain } from 'electron'
import type { SessionHistoryService } from '../session-history/session-history-service'

export function registerSessionHistoryHandlers(sessionHistory: SessionHistoryService): void {
  // Why: metadata-only DTO over the wire (AR-5) — transcript bodies stay in
  // the main process until Story 2.1's getTranscript.
  ipcMain.handle('sessionHistory:list', () => sessionHistory.list())

  // Why: no payload and no origin filtering — every window refetches over
  // sessionHistory:list, so a stale push can never deliver stale data.
  sessionHistory.onChanged(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('sessionHistory:changed')
      }
    }
  })

  sessionHistory.start()
}
