import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SessionHistoryRow } from './SessionHistoryRow'
import type { SessionMeta } from '../../../../shared/session-history-types'

const NOW = Date.parse('2026-06-11T12:00:00.000Z')

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: 'session-1',
    title: 'Fix the flaky scanner test',
    titleSource: 'firstMessage',
    lastActivity: '2026-06-11T11:55:00.000Z',
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/repo',
    isLive: false,
    ...overrides
  }
}

function renderRow(overrides: Partial<SessionMeta> = {}): string {
  return renderToStaticMarkup(<SessionHistoryRow session={makeSession(overrides)} now={NOW} />)
}

describe('SessionHistoryRow', () => {
  it('renders a native button with title text, native tooltip, and accessible name', () => {
    const markup = renderRow()

    expect(markup).toContain('<button')
    expect(markup).toContain('type="button"')
    expect(markup).toContain('Fix the flaky scanner test')
    expect(markup).toContain('title="Fix the flaky scanner test"')
    expect(markup).toContain('aria-label="Fix the flaky scanner test past session"')
  })

  it('renders the hollow-ring status dot, shape-distinct from filled live dots', () => {
    const markup = renderRow()

    expect(markup).toContain('border-[1.5px]')
    expect(markup).toContain('bg-transparent')
    expect(markup).toContain('border-muted-foreground/70')
  })

  it('renders the relative age and keeps it outside the truncating title span', () => {
    const longTitle = 'A very long session title that will certainly truncate '.repeat(4)
    const markup = renderRow({ title: longTitle })

    expect(markup).toContain('5m')
    expect(markup).toContain('tabular-nums')
    const truncateIndex = markup.indexOf('truncate')
    const ageIndex = markup.indexOf('>5m<')
    expect(truncateIndex).toBeGreaterThan(-1)
    expect(ageIndex).toBeGreaterThan(truncateIndex)
  })

  it('renders userRename titles full-weight with the ✎ glyph', () => {
    const markup = renderRow({ titleSource: 'userRename' })

    expect(markup).toContain('✎')
    expect(markup).toContain('text-foreground/85')
  })

  it('renders non-renamed titles muted, without the ✎ glyph', () => {
    const markup = renderRow({ titleSource: 'aiTitle' })

    expect(markup).not.toContain('✎')
    expect(markup).not.toContain('text-foreground/85')
  })

  it('omits the age on an unparseable lastActivity instead of rendering NaN', () => {
    const markup = renderRow({ lastActivity: 'not-a-timestamp' })

    expect(markup).not.toContain('NaN')
    expect(markup).not.toContain('tabular-nums')
  })
})
