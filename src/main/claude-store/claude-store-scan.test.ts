import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'os'
// Direct units re-pointed post-extraction; batch yielding + cache reuse are
// still observed through the public scanClaudeUsageFiles (which stays in scanner).
import { FILE_SCAN_BATCH_SIZE, getProcessedFileStat } from './claude-store-scan'

const tempRoots: string[] = []

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-store-scan-'))
  tempRoots.push(root)
  await mkdir(join(root, '.claude', 'projects', 'project-a'), { recursive: true })
  await mkdir(join(root, '.claude', 'transcripts'), { recursive: true })
  return root
}

function assistantLine(sessionId: string, inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: '2026-04-09T10:00:00.000Z',
    cwd: '/workspace/repo-a',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: inputTokens, output_tokens: 1 } }
  })
}

async function loadScanner(home: string) {
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof Os>('os')),
    homedir: () => home
  }))
  return import('../claude-usage/scanner')
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('os')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FILE_SCAN_BATCH_SIZE', () => {
  it('batches files in groups of four', () => {
    expect(FILE_SCAN_BATCH_SIZE).toBe(4)
  })
})

describe('getProcessedFileStat', () => {
  it('returns path/mtimeMs/size without reading line count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-store-stat-'))
    tempRoots.push(root)
    const file = join(root, 'a.jsonl')
    await writeFile(file, 'line-1\nline-2\n')

    const result = await getProcessedFileStat(file)
    expect(Object.keys(result).sort()).toEqual(['mtimeMs', 'path', 'size'])
    expect(result.path).toBe(file)
    expect(typeof result.mtimeMs).toBe('number')
    expect(typeof result.size).toBe('number')
  })
})

describe('batched scan yielding', () => {
  it('yields between batches but not after the final batch', async () => {
    const home = await makeHome()
    const projectDir = join(home, '.claude', 'projects', 'project-a')
    // 9 files -> ceil(9/4) = 3 batches -> 2 yields between them.
    for (let index = 0; index < 9; index++) {
      await writeFile(join(projectDir, `session-${index}.jsonl`), assistantLine(`s-${index}`, 10))
    }

    const { scanClaudeUsageFiles } = await loadScanner(home)
    const zeroDelayTimeouts = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void
    ) => {
      fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    await scanClaudeUsageFiles([])

    const yields = zeroDelayTimeouts.mock.calls.filter(([, delay]) => delay === 0)
    expect(yields).toHaveLength(2)
  })
})

describe('mtime/size incremental cache', () => {
  it('reuses the previous projection for an unchanged file (stat-only)', async () => {
    const home = await makeHome()
    const file = join(home, '.claude', 'projects', 'project-a', 'session-1.jsonl')
    await writeFile(file, assistantLine('session-1', 100))

    const { scanClaudeUsageFiles } = await loadScanner(home)
    const first = await scanClaudeUsageFiles([])
    const cached = structuredClone(first.processedFiles[0]!)
    // Poison the cached projection; a true reuse returns it verbatim.
    cached.sessions[0]!.totalInputTokens = 999

    const second = await scanClaudeUsageFiles([], [cached])
    expect(second.processedFiles[0]?.sessions[0]?.totalInputTokens).toBe(999)
  })

  it('reprocesses a file when its size changes', async () => {
    const home = await makeHome()
    const file = join(home, '.claude', 'projects', 'project-a', 'session-1.jsonl')
    await writeFile(file, assistantLine('session-1', 100))

    const { scanClaudeUsageFiles } = await loadScanner(home)
    const first = await scanClaudeUsageFiles([])
    const cached = structuredClone(first.processedFiles[0]!)
    cached.sessions[0]!.totalInputTokens = 999

    // Change content (alters size) so the cache must be invalidated.
    await writeFile(
      file,
      [assistantLine('session-1', 100), assistantLine('session-1', 50)].join('\n')
    )
    const second = await scanClaudeUsageFiles([], [cached])
    expect(second.processedFiles[0]?.sessions[0]?.totalInputTokens).toBe(150)
  })
})
