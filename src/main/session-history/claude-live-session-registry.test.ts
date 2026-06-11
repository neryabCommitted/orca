import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'os'
import type { ClaudeStoreFsAccessor } from './claude-store-fs-accessor'

const tempRoots: string[] = []

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-live-session-registry-'))
  tempRoots.push(root)
  return root
}

// The local accessor resolves ~/.claude from homedir() at module load, so
// mock os + dynamic-import per test (claude-session-history-provider.test.ts model).
async function loadModules(home: string) {
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof Os>('os')),
    homedir: () => home
  }))
  const registry = await import('./claude-live-session-registry')
  const accessor = await import('./claude-store-fs-accessor')
  return { ...registry, ...accessor }
}

afterEach(async () => {
  vi.doUnmock('os')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writeRecord(home: string, name: string, content: string): Promise<string> {
  const dir = join(home, '.claude', 'sessions')
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, content)
  return file
}

const alive = (): boolean => true
const dead = (): boolean => false

describe('readLiveSessionIds', () => {
  it('marks a session live when its record pid probes alive', async () => {
    const home = await makeHome()
    await writeRecord(home, '100.json', JSON.stringify({ pid: 100, sessionId: 'ses-a' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), alive)).resolves.toEqual(
      new Set(['ses-a'])
    )
  })

  it('never marks sessions live from dead-pid (stale) records', async () => {
    const home = await makeHome()
    await writeRecord(home, '100.json', JSON.stringify({ pid: 100, sessionId: 'ses-a' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), dead)).resolves.toEqual(
      new Set()
    )
  })

  it("probes the record's pid field, not the filename", async () => {
    const home = await makeHome()
    await writeRecord(home, '999.json', JSON.stringify({ pid: 4242, sessionId: 'ses-a' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    const probe = vi.fn((pid: number) => pid === 4242)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), probe)).resolves.toEqual(
      new Set(['ses-a'])
    )
    expect(probe).toHaveBeenCalledWith(4242)
    expect(probe).not.toHaveBeenCalledWith(999)
  })

  it('lets a live record win over a dead record pointing at the same sessionId', async () => {
    const home = await makeHome()
    await writeRecord(home, '100.json', JSON.stringify({ pid: 100, sessionId: 'ses-a' }))
    await writeRecord(home, '200.json', JSON.stringify({ pid: 200, sessionId: 'ses-a' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    const onlyPid200Alive = (pid: number): boolean => pid === 200
    await expect(
      readLiveSessionIds(createLocalClaudeStoreFsAccessor(), onlyPid200Alive)
    ).resolves.toEqual(new Set(['ses-a']))
  })

  it('skips torn or invalid JSON records but still reads the others', async () => {
    const home = await makeHome()
    await writeRecord(home, '100.json', '{"pid":100,"sessionId":"ses-a"')
    await writeRecord(home, '200.json', JSON.stringify({ pid: 200, sessionId: 'ses-b' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), alive)).resolves.toEqual(
      new Set(['ses-b'])
    )
  })

  it('skips records with missing or malformed sessionId/pid fields', async () => {
    const home = await makeHome()
    await writeRecord(home, '100.json', JSON.stringify({ pid: 100 }))
    await writeRecord(home, '200.json', JSON.stringify({ sessionId: 'ses-b' }))
    await writeRecord(home, '300.json', JSON.stringify({ pid: '300', sessionId: 'ses-c' }))
    await writeRecord(home, '400.json', JSON.stringify({ pid: 400, sessionId: '' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), alive)).resolves.toEqual(
      new Set()
    )
  })

  it('skips 0-byte records', async () => {
    const home = await makeHome()
    await writeRecord(home, '100.json', '')
    await writeRecord(home, '200.json', JSON.stringify({ pid: 200, sessionId: 'ses-b' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), alive)).resolves.toEqual(
      new Set(['ses-b'])
    )
  })

  it('skips records that exceed the defensive byte bound', async () => {
    const home = await makeHome()
    await writeRecord(
      home,
      '100.json',
      JSON.stringify({ pid: 100, sessionId: 'ses-a', padding: 'x'.repeat(10_000) })
    )
    await writeRecord(home, '200.json', JSON.stringify({ pid: 200, sessionId: 'ses-b' }))

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), alive)).resolves.toEqual(
      new Set(['ses-b'])
    )
  })

  it('returns an empty set when the sessions dir is missing or empty', async () => {
    const home = await makeHome()

    const { readLiveSessionIds, createLocalClaudeStoreFsAccessor } = await loadModules(home)
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), alive)).resolves.toEqual(
      new Set()
    )

    await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
    await expect(readLiveSessionIds(createLocalClaudeStoreFsAccessor(), alive)).resolves.toEqual(
      new Set()
    )
  })

  it('returns an empty set when the accessor listing throws', async () => {
    const home = await makeHome()
    const { readLiveSessionIds } = await loadModules(home)
    const throwingAccessor = {
      listLiveSessionFiles: () => Promise.reject(new Error('relay down'))
    } as unknown as ClaudeStoreFsAccessor

    await expect(readLiveSessionIds(throwingAccessor, alive)).resolves.toEqual(new Set())
  })
})

describe('defaultIsPidAlive', () => {
  it('reports the current process as alive and an absurd pid as dead', async () => {
    const home = await makeHome()
    const { defaultIsPidAlive } = await loadModules(home)
    expect(defaultIsPidAlive(process.pid)).toBe(true)
    expect(defaultIsPidAlive(2 ** 30)).toBe(false)
  })

  it('treats EPERM as alive (process exists but is not ours)', async () => {
    const home = await makeHome()
    const { defaultIsPidAlive } = await loadModules(home)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    try {
      expect(defaultIsPidAlive(1234)).toBe(true)
    } finally {
      killSpy.mockRestore()
    }
  })
})
