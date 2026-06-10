import { describe, expect, it } from 'vitest'
import {
  SESSION_METADATA_SCAN_MAX_BYTES,
  SESSION_METADATA_SCAN_MAX_LINES,
  buildFallbackSessionLabel,
  extractSessionFileMetadata
} from './claude-transcript-parser'

async function* toLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line
  }
}

describe('extractSessionFileMetadata', () => {
  it('skips leading records without cwd and captures the first cwd and timestamp', async () => {
    const lines = [
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'permission-mode', mode: 'acceptEdits' }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      JSON.stringify({
        type: 'user',
        cwd: '/workspace/repo-a',
        timestamp: '2026-06-09T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'user',
        cwd: '/workspace/elsewhere',
        timestamp: '2026-06-09T11:00:00.000Z'
      })
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T10:00:00.000Z'
    })
  })

  it('captures cwd and timestamp from different records', async () => {
    const lines = [
      JSON.stringify({ type: 'summary', timestamp: '2026-06-09T09:00:00.000Z' }),
      JSON.stringify({ type: 'user', cwd: '/workspace/repo-a' })
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T09:00:00.000Z'
    })
  })

  it('tolerates a torn trailing line without throwing', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        cwd: '/workspace/repo-a',
        timestamp: '2026-06-09T10:00:00.000Z'
      }),
      '{"type":"assistant","cwd":"/worksp'
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T10:00:00.000Z'
    })
  })

  it('returns nulls for a fully unparseable file', async () => {
    const lines = ['not json at all', '{"torn', '']

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: null,
      firstTimestamp: null
    })
  })

  it('ignores non-string cwd and timestamp values', async () => {
    const lines = [
      JSON.stringify({ type: 'user', cwd: 42, timestamp: { nested: true } }),
      JSON.stringify({ type: 'user', cwd: '', timestamp: '' }),
      JSON.stringify({
        type: 'user',
        cwd: '/workspace/repo-a',
        timestamp: '2026-06-09T10:00:00.000Z'
      })
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T10:00:00.000Z'
    })
  })

  it('stops scanning at the line cap', async () => {
    const filler = JSON.stringify({ type: 'mode', mode: 'default' })
    const lines = [
      ...Array.from({ length: SESSION_METADATA_SCAN_MAX_LINES }, () => filler),
      JSON.stringify({
        type: 'user',
        cwd: '/workspace/repo-a',
        timestamp: '2026-06-09T10:00:00.000Z'
      })
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: null,
      firstTimestamp: null
    })
  })

  it('stops scanning at the byte cap before the line cap', async () => {
    const bigLine = JSON.stringify({ type: 'mode', padding: 'x'.repeat(128 * 1024) })
    expect(bigLine.length * 2).toBeGreaterThan(SESSION_METADATA_SCAN_MAX_BYTES)
    const lines = [
      bigLine,
      bigLine,
      JSON.stringify({
        type: 'user',
        cwd: '/workspace/repo-a',
        timestamp: '2026-06-09T10:00:00.000Z'
      })
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: null,
      firstTimestamp: null
    })
  })

  it('stops pulling lines once both fields are found', async () => {
    async function* explodingAfterFirst(): AsyncIterable<string> {
      yield JSON.stringify({
        type: 'user',
        cwd: '/workspace/repo-a',
        timestamp: '2026-06-09T10:00:00.000Z'
      })
      throw new Error('iterated past the early-stop point')
    }

    await expect(extractSessionFileMetadata(explodingAfterFirst())).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T10:00:00.000Z'
    })
  })

  it('handles an empty input', async () => {
    await expect(extractSessionFileMetadata(toLines([]))).resolves.toEqual({
      cwd: null,
      firstTimestamp: null
    })
  })
})

describe('buildFallbackSessionLabel', () => {
  it('formats a locale-stable date with the short session id', () => {
    const label = buildFallbackSessionLabel(
      '2026-06-09T14:32:00.000Z',
      'a2829a6d-1111-2222-3333-444444444444'
    )
    // Hour depends on the local timezone; pin the stable parts.
    expect(label).toMatch(/^Jun \d{1,2}, \d{2}:\d{2} · a2829a6d$/)
  })

  it('falls back to the short id for an unparseable timestamp', () => {
    expect(buildFallbackSessionLabel('not-a-date', 'a2829a6d-1111')).toBe('a2829a6d')
  })

  it('is never empty', () => {
    expect(buildFallbackSessionLabel('not-a-date', '').length).toBeGreaterThan(0)
  })
})
