import { describe, expect, it } from 'vitest'
import {
  SESSION_LABEL_MAX_CHARS,
  SESSION_METADATA_SCAN_MAX_BYTES,
  SESSION_METADATA_SCAN_MAX_LINES,
  buildFallbackSessionLabel,
  deriveSessionTitle,
  extractSessionFileMetadata,
  normalizeSessionLabelText,
  type SessionFileMetadata
} from './claude-transcript-parser'

async function* toLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line
  }
}

const NULL_TITLE_TIERS = {
  customTitle: null,
  aiTitle: null,
  firstUserMessage: null
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
      firstTimestamp: '2026-06-09T10:00:00.000Z',
      ...NULL_TITLE_TIERS
    })
  })

  it('captures cwd and timestamp from different records', async () => {
    const lines = [
      JSON.stringify({ type: 'summary', timestamp: '2026-06-09T09:00:00.000Z' }),
      JSON.stringify({ type: 'user', cwd: '/workspace/repo-a' })
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T09:00:00.000Z',
      ...NULL_TITLE_TIERS
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
      firstTimestamp: '2026-06-09T10:00:00.000Z',
      ...NULL_TITLE_TIERS
    })
  })

  it('returns nulls for a fully unparseable file', async () => {
    const lines = ['not json at all', '{"torn', '']

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: null,
      firstTimestamp: null,
      ...NULL_TITLE_TIERS
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
      firstTimestamp: '2026-06-09T10:00:00.000Z',
      ...NULL_TITLE_TIERS
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
      firstTimestamp: null,
      ...NULL_TITLE_TIERS
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
      firstTimestamp: null,
      ...NULL_TITLE_TIERS
    })
  })

  it('parses the line that crosses the byte cap before stopping', async () => {
    const giant = JSON.stringify({
      type: 'user',
      cwd: '/workspace/repo-a',
      timestamp: '2026-06-09T10:00:00.000Z',
      padding: 'x'.repeat(SESSION_METADATA_SCAN_MAX_BYTES)
    })

    await expect(extractSessionFileMetadata(toLines([giant]))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T10:00:00.000Z',
      ...NULL_TITLE_TIERS
    })
  })

  it('does not scan past the line that crosses the byte cap', async () => {
    const giant = JSON.stringify({
      type: 'file-history-snapshot',
      padding: 'x'.repeat(SESSION_METADATA_SCAN_MAX_BYTES)
    })
    const lines = [giant, JSON.stringify({ type: 'user', cwd: '/workspace/repo-a' })]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: null,
      firstTimestamp: null,
      ...NULL_TITLE_TIERS
    })
  })

  it('keeps scanning after cwd and timestamp are found so later title records win', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        cwd: '/workspace/repo-a',
        timestamp: '2026-06-09T10:00:00.000Z'
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Found after cwd' })
    ]

    await expect(extractSessionFileMetadata(toLines(lines))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T10:00:00.000Z',
      customTitle: null,
      aiTitle: 'Found after cwd',
      firstUserMessage: null
    })
  })

  it('handles an empty input', async () => {
    await expect(extractSessionFileMetadata(toLines([]))).resolves.toEqual({
      cwd: null,
      firstTimestamp: null,
      ...NULL_TITLE_TIERS
    })
  })
})

describe('extractSessionFileMetadata title tiers', () => {
  async function extractTitles(lines: string[]): Promise<{
    customTitle: string | null
    aiTitle: string | null
    firstUserMessage: string | null
  }> {
    const { customTitle, aiTitle, firstUserMessage } = await extractSessionFileMetadata(
      toLines(lines)
    )
    return { customTitle, aiTitle, firstUserMessage }
  }

  it('captures the last ai-title within the cap', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'First generation' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Second generation' })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      aiTitle: 'Second generation'
    })
  })

  it('captures the last custom-title within the cap', async () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'First rename' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Second rename' })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      customTitle: 'Second rename'
    })
  })

  it('captures custom-title and ai-title independently', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Generated' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Renamed' })
    ]

    await expect(extractTitles(lines)).resolves.toEqual({
      customTitle: 'Renamed',
      aiTitle: 'Generated',
      firstUserMessage: null
    })
  })

  it('ignores an ai-title past the line cap', async () => {
    const filler = JSON.stringify({ type: 'mode', mode: 'default' })
    const lines = [
      ...Array.from({ length: SESSION_METADATA_SCAN_MAX_LINES }, () => filler),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Out of window' })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({ aiTitle: null })
  })

  it('prefers the in-window ai-title over one past the line cap', async () => {
    const filler = JSON.stringify({ type: 'mode', mode: 'default' })
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'In window' }),
      ...Array.from({ length: SESSION_METADATA_SCAN_MAX_LINES }, () => filler),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Out of window' })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({ aiTitle: 'In window' })
  })

  it('ignores an ai-title past the byte cap', async () => {
    const bigLine = JSON.stringify({ type: 'mode', padding: 'x'.repeat(128 * 1024) })
    const lines = [bigLine, bigLine, JSON.stringify({ type: 'ai-title', aiTitle: 'Out of window' })]

    await expect(extractTitles(lines)).resolves.toMatchObject({ aiTitle: null })
  })

  it('skips an empty ai-title record', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Kept' }),
      JSON.stringify({ type: 'ai-title', aiTitle: '' })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({ aiTitle: 'Kept' })
  })

  it('skips a whitespace-only custom-title record', async () => {
    const lines = [JSON.stringify({ type: 'custom-title', customTitle: '   \n ' })]

    await expect(extractTitles(lines)).resolves.toMatchObject({ customTitle: null })
  })

  it('collapses embedded newlines in an ai-title to single spaces', async () => {
    const lines = [JSON.stringify({ type: 'ai-title', aiTitle: 'Line one\n\tline two' })]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      aiTitle: 'Line one line two'
    })
  })

  it('keeps an ai-title captured before a torn trailing line', async () => {
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Survives the tear' }),
      '{"type":"ai-title","aiTitle":"torn mid-rec'
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      aiTitle: 'Survives the tear'
    })
  })

  it('captures the first real user message with plain string content', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'we need to talk to the business analyst' }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'a later message' }
      })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      firstUserMessage: 'we need to talk to the business analyst'
    })
  })

  it('skips command and caveat noise before the real first message', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: The messages below were generated…'
        }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<command-name>/model</command-name>' }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'the real question' }
      })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      firstUserMessage: 'the real question'
    })
  })

  it('skips sidechain user records', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'subagent prompt' }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'main thread message' }
      })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      firstUserMessage: 'main thread message'
    })
  })

  it('skips tool_result array content user records', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'typed after the tool ran' }
      })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      firstUserMessage: 'typed after the tool ran'
    })
  })

  it('skips whitespace-only user messages', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '   \n ' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'real text' } })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      firstUserMessage: 'real text'
    })
  })

  it('accepts the first text part of array content (image-paste prompts)', async () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'zzz' } },
            { type: 'text', text: 'what is in this screenshot?' }
          ]
        }
      })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({
      firstUserMessage: 'what is in this screenshot?'
    })
  })

  it('skips user records without a message role of user', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'assistant', content: 'not mine' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'mine' } })
    ]

    await expect(extractTitles(lines)).resolves.toMatchObject({ firstUserMessage: 'mine' })
  })

  it('caps the first user message at capture time so the full body never escapes', async () => {
    const body = 'a'.repeat(5000)
    const lines = [JSON.stringify({ type: 'user', message: { role: 'user', content: body } })]

    const { firstUserMessage } = await extractSessionFileMetadata(toLines(lines))
    expect(firstUserMessage).toBe(`${'a'.repeat(SESSION_LABEL_MAX_CHARS)}…`)
    expect(firstUserMessage?.length).toBe(SESSION_LABEL_MAX_CHARS + 1)
  })

  it('returns null title fields for an all-noise file', async () => {
    const lines = [
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>Caveat…' }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }
      })
    ]

    await expect(extractTitles(lines)).resolves.toEqual({
      customTitle: null,
      aiTitle: null,
      firstUserMessage: null
    })
  })
})

describe('normalizeSessionLabelText', () => {
  it('collapses whitespace runs to single spaces and trims', () => {
    expect(normalizeSessionLabelText('  fix \t the \n\n bug  ')).toBe('fix the bug')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(normalizeSessionLabelText('')).toBeNull()
    expect(normalizeSessionLabelText(' \n\t ')).toBeNull()
  })

  it('keeps an exactly-80-char string without an ellipsis', () => {
    const exact = 'x'.repeat(SESSION_LABEL_MAX_CHARS)
    expect(normalizeSessionLabelText(exact)).toBe(exact)
  })

  it('caps an 81-char string at 80 chars plus an ellipsis', () => {
    const long = 'x'.repeat(SESSION_LABEL_MAX_CHARS + 1)
    expect(normalizeSessionLabelText(long)).toBe(`${'x'.repeat(SESSION_LABEL_MAX_CHARS)}…`)
  })
})

describe('deriveSessionTitle', () => {
  const LAST_ACTIVITY = '2026-06-09T14:32:00.000Z'
  const SESSION_ID = 'a2829a6d-1111-2222-3333-444444444444'

  function metadataWith(overrides: Partial<SessionFileMetadata>): SessionFileMetadata {
    return {
      cwd: null,
      firstTimestamp: null,
      customTitle: null,
      aiTitle: null,
      firstUserMessage: null,
      ...overrides
    }
  }

  it('prefers the user rename over every other tier', () => {
    const metadata = metadataWith({
      customTitle: 'My renamed session',
      aiTitle: 'Generated title',
      firstUserMessage: 'first message'
    })

    expect(deriveSessionTitle(metadata, LAST_ACTIVITY, SESSION_ID)).toEqual({
      title: 'My renamed session',
      titleSource: 'userRename'
    })
  })

  it('prefers the ai title over the first message', () => {
    const metadata = metadataWith({
      aiTitle: 'Generated title',
      firstUserMessage: 'first message'
    })

    expect(deriveSessionTitle(metadata, LAST_ACTIVITY, SESSION_ID)).toEqual({
      title: 'Generated title',
      titleSource: 'aiTitle'
    })
  })

  it('uses the first user message when no title records exist', () => {
    const metadata = metadataWith({ firstUserMessage: 'first message' })

    expect(deriveSessionTitle(metadata, LAST_ACTIVITY, SESSION_ID)).toEqual({
      title: 'first message',
      titleSource: 'firstMessage'
    })
  })

  it('falls back to the timestamp + short id label when all tiers are null', () => {
    const result = deriveSessionTitle(metadataWith({}), LAST_ACTIVITY, SESSION_ID)

    expect(result.titleSource).toBe('fallback')
    expect(result.title).toBe(buildFallbackSessionLabel(LAST_ACTIVITY, SESSION_ID))
  })

  it('never yields an empty title, even with no usable inputs', () => {
    const result = deriveSessionTitle(metadataWith({}), 'not-a-date', '')

    expect(result.titleSource).toBe('fallback')
    expect(result.title.length).toBeGreaterThan(0)
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
