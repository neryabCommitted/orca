import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHistoryService } from '../session-history/session-history-service'

const { getAllWindowsMock, handleMock } = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock },
  ipcMain: { handle: handleMock }
}))

import { registerSessionHistoryHandlers } from './session-history'

function makeFakeService() {
  let changedListener: (() => void) | null = null
  const service = {
    list: vi.fn(async () => [{ sessionId: 'ses-a' }]),
    onChanged: vi.fn((listener: () => void) => {
      changedListener = listener
      return () => {}
    }),
    start: vi.fn()
  }
  return {
    service: service as unknown as SessionHistoryService,
    listMock: service.list,
    startMock: service.start,
    emitChanged: () => changedListener?.()
  }
}

function makeWindow(options?: {
  windowDestroyed?: boolean
  contentsDestroyed?: boolean
  sendThrows?: boolean
}) {
  const send = vi.fn(() => {
    if (options?.sendThrows) {
      throw new Error('render frame disposed')
    }
  })
  return {
    isDestroyed: () => options?.windowDestroyed ?? false,
    webContents: {
      isDestroyed: () => options?.contentsDestroyed ?? false,
      send
    }
  }
}

beforeEach(() => {
  getAllWindowsMock.mockReset()
  getAllWindowsMock.mockReturnValue([])
  handleMock.mockClear()
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

describe('registerSessionHistoryHandlers', () => {
  it('registers sessionHistory:list delegating to the service', async () => {
    const { service, listMock } = makeFakeService()
    registerSessionHistoryHandlers(service)

    const listEntry = handleMock.mock.calls.find(([channel]) => channel === 'sessionHistory:list')
    expect(listEntry).toBeDefined()
    await expect(listEntry![1]()).resolves.toEqual([{ sessionId: 'ses-a' }])
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('starts the service after registration', () => {
    const { service, startMock } = makeFakeService()
    registerSessionHistoryHandlers(service)
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it('broadcasts sessionHistory:changed to every live window', () => {
    const windowA = makeWindow()
    const windowB = makeWindow()
    getAllWindowsMock.mockReturnValue([windowA, windowB])
    const { service, emitChanged } = makeFakeService()
    registerSessionHistoryHandlers(service)

    emitChanged()
    expect(windowA.webContents.send).toHaveBeenCalledWith('sessionHistory:changed')
    expect(windowB.webContents.send).toHaveBeenCalledWith('sessionHistory:changed')
  })

  it('skips destroyed windows and destroyed webContents', () => {
    const destroyedWindow = makeWindow({ windowDestroyed: true })
    const destroyedContents = makeWindow({ contentsDestroyed: true })
    const healthy = makeWindow()
    getAllWindowsMock.mockReturnValue([destroyedWindow, destroyedContents, healthy])
    const { service, emitChanged } = makeFakeService()
    registerSessionHistoryHandlers(service)

    emitChanged()
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled()
    expect(destroyedContents.webContents.send).not.toHaveBeenCalled()
    expect(healthy.webContents.send).toHaveBeenCalledWith('sessionHistory:changed')
  })

  it('keeps broadcasting to the remaining windows when one send throws', () => {
    const dying = makeWindow({ sendThrows: true })
    const healthy = makeWindow()
    getAllWindowsMock.mockReturnValue([dying, healthy])
    const { service, emitChanged } = makeFakeService()
    registerSessionHistoryHandlers(service)

    expect(emitChanged).not.toThrow()
    expect(healthy.webContents.send).toHaveBeenCalledWith('sessionHistory:changed')
  })
})
