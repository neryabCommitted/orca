import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'os'
import { extractSessionFileMetadata } from './claude-transcript-parser'

const tempRoots: string[] = []

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-history-accessor-'))
  tempRoots.push(root)
  return root
}

// The discovery module resolves ~/.claude from homedir() at module load, so
// mock os + dynamic-import per test (mirrors claude-store-discovery.test.ts).
async function loadAccessor(home: string) {
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof Os>('os')),
    homedir: () => home
  }))
  return import('./claude-store-fs-accessor')
}

afterEach(async () => {
  vi.doUnmock('os')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('createLocalClaudeStoreFsAccessor', () => {
  it('lists session files from the projects root only', async () => {
    const home = await makeHome()
    const projectDir = join(home, '.claude', 'projects', '-workspace-repo-a')
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(home, '.claude', 'transcripts'), { recursive: true })
    const sessionFile = join(projectDir, 'session-1.jsonl')
    await writeFile(sessionFile, '{}')
    await writeFile(join(home, '.claude', 'transcripts', 'ses_1.jsonl'), '{}')

    const { createLocalClaudeStoreFsAccessor } = await loadAccessor(home)
    await expect(createLocalClaudeStoreFsAccessor().listSessionFiles()).resolves.toEqual([
      sessionFile
    ])
  })

  it('stats a file with mtime and size', async () => {
    const home = await makeHome()
    const file = join(home, 'a.jsonl')
    await writeFile(file, '{"type":"mode"}\n')

    const { createLocalClaudeStoreFsAccessor } = await loadAccessor(home)
    const stat = await createLocalClaudeStoreFsAccessor().statFile(file)
    expect(stat.path).toBe(file)
    expect(stat.size).toBeGreaterThan(0)
    expect(stat.mtimeMs).toBeGreaterThan(0)
  })

  it('streams lines from a real on-disk-shaped session file into the metadata parser', async () => {
    const home = await makeHome()
    const file = join(home, 'session.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'mode', mode: 'default' }),
        JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
        JSON.stringify({
          type: 'user',
          cwd: '/workspace/repo-a',
          timestamp: '2026-06-09T10:00:00.000Z'
        }),
        '{"type":"assistant","cwd":"/worksp' // torn trailing line, mid-append
      ].join('\n')
    )

    const { createLocalClaudeStoreFsAccessor } = await loadAccessor(home)
    const accessor = createLocalClaudeStoreFsAccessor()
    await expect(extractSessionFileMetadata(accessor.readLines(file))).resolves.toEqual({
      cwd: '/workspace/repo-a',
      firstTimestamp: '2026-06-09T10:00:00.000Z',
      customTitle: null,
      aiTitle: null,
      firstUserMessage: null
    })
  })

  it('exposes no write capability', async () => {
    const home = await makeHome()
    const { createLocalClaudeStoreFsAccessor } = await loadAccessor(home)
    const accessor = createLocalClaudeStoreFsAccessor()
    expect(Object.keys(accessor).sort()).toEqual(['listSessionFiles', 'readLines', 'statFile'])
  })
})
