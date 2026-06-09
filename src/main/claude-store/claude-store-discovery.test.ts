import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'os'

const tempRoots: string[] = []

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-store-discovery-'))
  tempRoots.push(root)
  return root
}

// listClaudeTranscriptFiles reads roots derived from homedir() at module load,
// so mock os + dynamic-import per test (mirrors scanner-scan.test.ts).
async function loadDiscovery(home: string) {
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof Os>('os')),
    homedir: () => home
  }))
  return import('./claude-store-discovery')
}

afterEach(async () => {
  vi.doUnmock('os')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('listClaudeTranscriptFiles', () => {
  it('discovers nested .jsonl files under the encoded-cwd project dir', async () => {
    const home = await makeHome()
    const projectDir = join(home, '.claude', 'projects', '-workspace-repo-a', 'nested')
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(home, '.claude', 'transcripts'), { recursive: true })
    const file = join(projectDir, 'session-1.jsonl')
    await writeFile(file, '{}')

    const { listClaudeTranscriptFiles } = await loadDiscovery(home)
    await expect(listClaudeTranscriptFiles()).resolves.toEqual([file])
  })

  it('ignores non-.jsonl files', async () => {
    const home = await makeHome()
    const projectDir = join(home, '.claude', 'projects', 'project-a')
    await mkdir(projectDir, { recursive: true })
    await mkdir(join(home, '.claude', 'transcripts'), { recursive: true })
    const keep = join(projectDir, 'keep.jsonl')
    await writeFile(keep, '{}')
    await writeFile(join(projectDir, 'ignore.json'), '{}')
    await writeFile(join(projectDir, 'ignore.txt'), 'x')

    const { listClaudeTranscriptFiles } = await loadDiscovery(home)
    await expect(listClaudeTranscriptFiles()).resolves.toEqual([keep])
  })

  it('merges both roots and returns a sorted, de-duplicated list', async () => {
    const home = await makeHome()
    const projectDir = join(home, '.claude', 'projects', 'project-a')
    const transcriptsDir = join(home, '.claude', 'transcripts')
    await mkdir(projectDir, { recursive: true })
    await mkdir(transcriptsDir, { recursive: true })
    const b = join(projectDir, 'b.jsonl')
    const a = join(projectDir, 'a.jsonl')
    const t = join(transcriptsDir, 'ses_1.jsonl')
    await writeFile(b, '{}')
    await writeFile(a, '{}')
    await writeFile(t, '{}')

    const { listClaudeTranscriptFiles } = await loadDiscovery(home)
    const result = await listClaudeTranscriptFiles()
    expect(result).toEqual([...new Set(result)])
    expect(result).toEqual([a, b, t].sort())
  })

  it('returns an empty array when both roots are missing', async () => {
    const home = await makeHome()

    const { listClaudeTranscriptFiles } = await loadDiscovery(home)
    await expect(listClaudeTranscriptFiles()).resolves.toEqual([])
  })
})
