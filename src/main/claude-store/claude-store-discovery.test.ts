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

describe('listClaudeLiveSessionRecordFiles', () => {
  it('lists only .json records in the flat sessions dir, sorted', async () => {
    const home = await makeHome()
    const sessionsDir = join(home, '.claude', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const b = join(sessionsDir, '63251.json')
    const a = join(sessionsDir, '63250.json')
    await writeFile(b, '{}')
    await writeFile(a, '{}')
    await writeFile(join(sessionsDir, 'ignore.jsonl'), '{}')
    await writeFile(join(sessionsDir, 'ignore.txt'), 'x')

    const { listClaudeLiveSessionRecordFiles } = await loadDiscovery(home)
    await expect(listClaudeLiveSessionRecordFiles()).resolves.toEqual([a, b])
  })

  it('ignores subdirectories, including .json-named ones', async () => {
    const home = await makeHome()
    const sessionsDir = join(home, '.claude', 'sessions')
    await mkdir(join(sessionsDir, 'nested.json'), { recursive: true })
    const record = join(sessionsDir, '100.json')
    await writeFile(record, '{}')

    const { listClaudeLiveSessionRecordFiles } = await loadDiscovery(home)
    await expect(listClaudeLiveSessionRecordFiles()).resolves.toEqual([record])
  })

  it('returns an empty array when the sessions dir is missing', async () => {
    const home = await makeHome()

    const { listClaudeLiveSessionRecordFiles } = await loadDiscovery(home)
    await expect(listClaudeLiveSessionRecordFiles()).resolves.toEqual([])
  })
})

describe('listClaudeProjectSessionFiles', () => {
  it('lists only files under the projects root, excluding transcripts', async () => {
    const home = await makeHome()
    const projectDir = join(home, '.claude', 'projects', '-workspace-repo-a')
    const transcriptsDir = join(home, '.claude', 'transcripts')
    await mkdir(projectDir, { recursive: true })
    await mkdir(transcriptsDir, { recursive: true })
    const sessionFile = join(projectDir, 'session-1.jsonl')
    await writeFile(sessionFile, '{}')
    await writeFile(join(transcriptsDir, 'ses_1.jsonl'), '{}')
    await writeFile(join(projectDir, 'ignore.json'), '{}')

    const { listClaudeProjectSessionFiles } = await loadDiscovery(home)
    await expect(listClaudeProjectSessionFiles()).resolves.toEqual([sessionFile])
  })

  it('returns an empty array when the projects root is missing', async () => {
    const home = await makeHome()
    await mkdir(join(home, '.claude', 'transcripts'), { recursive: true })

    const { listClaudeProjectSessionFiles } = await loadDiscovery(home)
    await expect(listClaudeProjectSessionFiles()).resolves.toEqual([])
  })
})
