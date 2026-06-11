// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'
import { ExperimentalPane } from './ExperimentalPane'
import { getExperimentalPaneSearchEntries } from './experimental-search'

const mocks = vi.hoisted(() => ({
  state: {
    settingsSearchQuery: ''
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

const mountedRoots: Root[] = []

async function renderPane(
  settings: GlobalSettings,
  updateSettings: (updates: Partial<GlobalSettings>) => void = vi.fn()
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(<ExperimentalPane settings={settings} updateSettings={updateSettings} />)
  })

  return container
}

function getSessionHistorySwitch(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('#experimental-session-history [role="switch"]')
}

function getCountInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    '#experimental-session-history input[type="number"]'
  )
}

// Why: the block holds exactly two non-switch buttons in DOM order —
// Minus then Plus — so positional lookup stays stable without test ids.
function getCountButtons(container: HTMLElement): {
  minus: HTMLButtonElement | null
  plus: HTMLButtonElement | null
} {
  const buttons = container.querySelectorAll<HTMLButtonElement>(
    '#experimental-session-history button:not([role="switch"])'
  )
  return { minus: buttons[0] ?? null, plus: buttons[1] ?? null }
}

async function clickElement(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function typeIntoCountInput(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    const input = getCountInput(container)
    if (!input) {
      throw new Error('Missing session-history count input')
    }
    // Why: React reads controlled-input changes via the native value setter;
    // assigning input.value directly is swallowed by React's value tracking.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ExperimentalPane', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.settingsSearchQuery = ''
  })

  it('does not render compact worktree cards after graduation from Experimental', () => {
    const markup = renderToStaticMarkup(
      <ExperimentalPane settings={getDefaultSettings('/tmp')} updateSettings={vi.fn()} />
    )

    expect(markup).not.toContain('Compact worktree cards')
    expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).not.toContain(
      'Compact worktree cards'
    )
  })

  describe('Claude Code session history', () => {
    it('is listed in the pane search entries', () => {
      expect(getExperimentalPaneSearchEntries().map((entry) => entry.title)).toContain(
        'Claude Code session history'
      )
    })

    it('renders off by default with the count at 5 and the count row disabled', async () => {
      const container = await renderPane(getDefaultSettings('/tmp'))

      expect(container.textContent).toContain('Claude Code session history')
      expect(getSessionHistorySwitch(container)?.getAttribute('aria-checked')).toBe('false')

      const input = getCountInput(container)
      expect(input?.value).toBe('5')
      expect(input?.disabled).toBe(true)

      const { minus, plus } = getCountButtons(container)
      expect(minus?.disabled).toBe(true)
      expect(plus?.disabled).toBe(true)
    })

    it('toggles the setting on via updateSettings when off', async () => {
      const updateSettings = vi.fn()
      const container = await renderPane(getDefaultSettings('/tmp'), updateSettings)

      const switchButton = getSessionHistorySwitch(container)
      expect(switchButton).not.toBeNull()
      await clickElement(switchButton as Element)

      expect(updateSettings).toHaveBeenCalledWith({ sessionHistoryEnabled: true })
    })

    it('toggles the setting off via updateSettings when on', async () => {
      const updateSettings = vi.fn()
      const settings = { ...getDefaultSettings('/tmp'), sessionHistoryEnabled: true }
      const container = await renderPane(settings, updateSettings)

      expect(getSessionHistorySwitch(container)?.getAttribute('aria-checked')).toBe('true')
      await clickElement(getSessionHistorySwitch(container) as Element)

      expect(updateSettings).toHaveBeenCalledWith({ sessionHistoryEnabled: false })
    })

    it('steps the count by one in each direction when enabled', async () => {
      const updateSettings = vi.fn()
      const settings = { ...getDefaultSettings('/tmp'), sessionHistoryEnabled: true }
      const container = await renderPane(settings, updateSettings)

      const { minus, plus } = getCountButtons(container)
      expect(minus?.disabled).toBe(false)
      expect(plus?.disabled).toBe(false)

      await clickElement(plus as Element)
      expect(updateSettings).toHaveBeenCalledWith({ sessionHistoryShownCount: 6 })

      await clickElement(minus as Element)
      expect(updateSettings).toHaveBeenCalledWith({ sessionHistoryShownCount: 4 })
    })

    it('disables decrement at 1 and increment at 50', async () => {
      const atMin = await renderPane({
        ...getDefaultSettings('/tmp'),
        sessionHistoryEnabled: true,
        sessionHistoryShownCount: 1
      })
      expect(getCountButtons(atMin).minus?.disabled).toBe(true)
      expect(getCountButtons(atMin).plus?.disabled).toBe(false)

      const atMax = await renderPane({
        ...getDefaultSettings('/tmp'),
        sessionHistoryEnabled: true,
        sessionHistoryShownCount: 50
      })
      expect(getCountButtons(atMax).minus?.disabled).toBe(false)
      expect(getCountButtons(atMax).plus?.disabled).toBe(true)
    })

    it('commits typed values only when they land in 1-50', async () => {
      const updateSettings = vi.fn()
      const settings = { ...getDefaultSettings('/tmp'), sessionHistoryEnabled: true }
      const container = await renderPane(settings, updateSettings)

      await typeIntoCountInput(container, '0')
      await typeIntoCountInput(container, '51')
      await typeIntoCountInput(container, '')
      expect(updateSettings).not.toHaveBeenCalled()

      await typeIntoCountInput(container, '12')
      expect(updateSettings).toHaveBeenCalledWith({ sessionHistoryShownCount: 12 })
    })

    it('stays visible for a matching search query and hides for an unrelated one', async () => {
      mocks.state.settingsSearchQuery = 'session history'
      const matching = await renderPane(getDefaultSettings('/tmp'))
      expect(matching.querySelector('#experimental-session-history')).not.toBeNull()

      mocks.state.settingsSearchQuery = 'mascot'
      const unrelated = await renderPane(getDefaultSettings('/tmp'))
      expect(unrelated.querySelector('#experimental-session-history')).toBeNull()
    })
  })
})
