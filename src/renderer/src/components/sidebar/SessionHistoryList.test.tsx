// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '../../../../shared/session-history-types'

type MockSettings = {
  sessionHistoryEnabled?: boolean
  sessionHistoryShownCount?: number
}

type MockState = {
  settings: MockSettings | null
  sessionHistorySessions: SessionMeta[]
  sessionHistoryLoaded: boolean
  collapsedGroups: Set<string>
  toggleCollapsedGroup: (key: string) => void
}

const mocks = vi.hoisted(() => ({
  state: {
    settings: { sessionHistoryEnabled: true, sessionHistoryShownCount: 5 },
    sessionHistorySessions: [],
    sessionHistoryLoaded: true,
    collapsedGroups: new Set(),
    toggleCollapsedGroup: vi.fn()
  } as unknown as { current?: never } & Record<string, unknown>
}))

const state = mocks.state as unknown as MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: MockState) => unknown) => selector(state)
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null,
  SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT: 'orca-suppress-worktree-list-scroll-adjustment'
}))

import { SessionHistoryList } from './SessionHistoryList'

function makeSession(index: number, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: `session-${index}`,
    title: `Session title ${index}`,
    titleSource: 'firstMessage',
    lastActivity: '2026-06-11T10:00:00.000Z',
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/repo',
    isLive: false,
    ...overrides
  }
}

function makeSessions(count: number, overrides: Partial<SessionMeta> = {}): SessionMeta[] {
  return Array.from({ length: count }, (_, i) => makeSession(i, overrides))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  state.settings = { sessionHistoryEnabled: true, sessionHistoryShownCount: 5 }
  state.sessionHistorySessions = []
  state.sessionHistoryLoaded = true
  state.collapsedGroups = new Set()
  state.toggleCollapsedGroup = vi.fn()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.clearAllMocks()
})

function render(repoId = 'repo-1'): void {
  act(() => {
    root.render(<SessionHistoryList repoId={repoId} />)
  })
}

function rowButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[title]'))
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ??
    null
  )
}

describe('SessionHistoryList render gating', () => {
  it('renders nothing when the setting is disabled', () => {
    state.settings = { sessionHistoryEnabled: false }
    state.sessionHistorySessions = makeSessions(3)
    render()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing pre-hydration (settings === null) without crashing', () => {
    state.settings = null
    state.sessionHistorySessions = makeSessions(3)
    render()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing before the first list() resolves', () => {
    state.sessionHistoryLoaded = false
    state.sessionHistorySessions = makeSessions(3)
    render()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the repo has zero mapped sessions', () => {
    render()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when sessions exist only for another repoId', () => {
    state.sessionHistorySessions = makeSessions(3, { repoId: 'repo-other' })
    render()
    expect(container.innerHTML).toBe('')
  })

  it('never matches repoId:null sessions and does not crash on them', () => {
    state.sessionHistorySessions = makeSessions(3, { repoId: null })
    render()
    expect(container.innerHTML).toBe('')
  })
})

describe('SessionHistoryList progressive disclosure', () => {
  it('shows shownCount rows, the visible-set header count, and the expander', () => {
    state.sessionHistorySessions = makeSessions(7)
    render()

    expect(container.textContent).toContain('Past sessions · 7')
    expect(rowButtons()).toHaveLength(5)
    expect(buttonByText('Show 2 more')).not.toBeNull()
  })

  it('expands the tail on click and flips to Show fewer, then collapses back', () => {
    state.sessionHistorySessions = makeSessions(7)
    render()

    act(() => {
      buttonByText('Show 2 more')!.click()
    })
    expect(rowButtons()).toHaveLength(7)
    expect(buttonByText('Show fewer')).not.toBeNull()

    act(() => {
      buttonByText('Show fewer')!.click()
    })
    expect(rowButtons()).toHaveLength(5)
    expect(buttonByText('Show 2 more')).not.toBeNull()
  })

  it('renders no expander when sessions fit exactly in shownCount', () => {
    state.sessionHistorySessions = makeSessions(5)
    render()

    expect(rowButtons()).toHaveLength(5)
    expect(buttonByText('more')).toBeNull()
    expect(buttonByText('Show fewer')).toBeNull()
  })

  it('renders Show 1 more at shownCount + 1', () => {
    state.sessionHistorySessions = makeSessions(6)
    render()

    expect(buttonByText('Show 1 more')).not.toBeNull()
  })

  it('clamps an out-of-range shownCount to 50', () => {
    state.settings = { sessionHistoryEnabled: true, sessionHistoryShownCount: 999 }
    state.sessionHistorySessions = makeSessions(60)
    render()

    expect(rowButtons()).toHaveLength(50)
    expect(buttonByText('Show 10 more')).not.toBeNull()
  })
})

describe('SessionHistoryList live de-dupe and empty state', () => {
  it('excludes live sessions from rows and from the header count', () => {
    state.sessionHistorySessions = [
      makeSession(0),
      makeSession(1, { isLive: true, title: 'Live session title' }),
      makeSession(2)
    ]
    render()

    expect(container.textContent).toContain('Past sessions · 2')
    expect(rowButtons()).toHaveLength(2)
    expect(container.textContent).not.toContain('Live session title')
  })

  it('renders the faint empty line when every mapped session is live', () => {
    state.sessionHistorySessions = makeSessions(2, { isLive: true })
    render()

    expect(container.textContent).toContain('Past sessions · 0')
    expect(rowButtons()).toHaveLength(0)
    expect(container.textContent).toContain('No past sessions yet')
  })
})

describe('SessionHistoryList collapse persistence', () => {
  it('toggles via toggleCollapsedGroup with the namespaced key on header click', () => {
    state.sessionHistorySessions = makeSessions(2)
    render()

    const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(header).not.toBeNull()
    act(() => {
      header.click()
    })
    expect(state.toggleCollapsedGroup).toHaveBeenCalledWith('sessionHistory:repo-1')
  })

  it('dispatches the scroll-suppression event before flipping the header state', () => {
    state.sessionHistorySessions = makeSessions(2)
    const suppressSpy = vi.fn()
    window.addEventListener('orca-suppress-worktree-list-scroll-adjustment', suppressSpy)
    render()

    act(() => {
      ;(container.querySelector('button[aria-expanded]') as HTMLButtonElement).click()
    })
    expect(suppressSpy).toHaveBeenCalled()
    window.removeEventListener('orca-suppress-worktree-list-scroll-adjustment', suppressSpy)
  })

  it('respects a persisted collapsed key on first render', () => {
    state.sessionHistorySessions = makeSessions(3)
    state.collapsedGroups = new Set(['sessionHistory:repo-1'])
    render()

    const header = container.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(rowButtons()).toHaveLength(0)
  })
})
