import { mkdtemp, mkdir, readdir, rm, stat, symlink, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { realpath } from 'fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'os'
import type {
  SessionHistoryProjectScope,
  SessionHistoryScopeRoot
} from '../../shared/session-history-types'

const tempRoots: string[] = []

async function makeHome(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'orca-session-history-provider-'))
  tempRoots.push(created)
  // realpath so canonicalized assertions survive symlinked tmp dirs (e.g. macOS /tmp).
  return realpath(created)
}

// The local accessor resolves ~/.claude from homedir() at module load, so
// mock os + dynamic-import per test (the scanner-scan.test.ts pattern).
async function loadModules(home: string) {
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof Os>('os')),
    homedir: () => home
  }))
  const provider = await import('./claude-session-history-provider')
  const accessor = await import('./claude-store-fs-accessor')
  return { ...provider, ...accessor }
}

afterEach(async () => {
  vi.doUnmock('os')
  vi.resetModules()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function sessionLines(cwd: string | null, timestamp = '2026-06-09T10:00:00.000Z'): string {
  return [
    JSON.stringify({ type: 'mode', mode: 'default' }),
    JSON.stringify({ type: 'permission-mode', mode: 'acceptEdits' }),
    JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
    JSON.stringify(
      cwd
        ? { type: 'user', cwd, timestamp, message: { role: 'user', content: 'secret body text' } }
        : { type: 'user', timestamp }
    )
  ].join('\n')
}

async function writeSession(
  home: string,
  encodedDir: string,
  sessionId: string,
  content: string
): Promise<string> {
  const dir = join(home, '.claude', 'projects', encodedDir)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  await writeFile(file, content)
  return file
}

function scopeOf(...roots: SessionHistoryScopeRoot[]): SessionHistoryProjectScope {
  return { roots }
}

async function makeWorktree(home: string, ...segments: string[]): Promise<string> {
  const dir = join(home, ...segments)
  await mkdir(dir, { recursive: true })
  return dir
}

describe('ClaudeSessionHistoryProvider.listSessions', () => {
  it('lists one metadata-only SessionMeta per session, sorted most-recent-first', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    const older = await writeSession(
      home,
      '-ws-app-feature',
      'aaaa1111-0000-0000-0000-000000000001',
      sessionLines(worktree)
    )
    const newer = await writeSession(
      home,
      '-ws-app-feature',
      'bbbb2222-0000-0000-0000-000000000002',
      sessionLines(worktree)
    )
    await utimes(older, new Date('2026-06-08T10:00:00Z'), new Date('2026-06-08T10:00:00Z'))
    await utimes(newer, new Date('2026-06-09T10:00:00Z'), new Date('2026-06-09T10:00:00Z'))

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
    )

    expect(sessions.map((s) => s.sessionId)).toEqual([
      'bbbb2222-0000-0000-0000-000000000002',
      'aaaa1111-0000-0000-0000-000000000001'
    ])
    for (const session of sessions) {
      expect(Object.keys(session).sort()).toEqual([
        'cwd',
        'isLive',
        'lastActivity',
        'repoId',
        'sessionId',
        'title',
        'titleSource',
        'worktreeId'
      ])
      expect(session).toMatchObject({
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        cwd: worktree,
        titleSource: 'fallback',
        isLive: false
      })
      expect(session.title.length).toBeGreaterThan(0)
      expect(JSON.stringify(session)).not.toContain('secret body text')
    }
    expect(sessions[0].lastActivity).toBe('2026-06-09T10:00:00.000Z')
  })

  it('resolves a deleted-worktree session via the repo-level root', async () => {
    const home = await makeHome()
    const repoRoot = await makeWorktree(home, 'ws', 'app')
    const deletedCwd = join(repoRoot, 'deleted-feature') // never created on disk
    await writeSession(
      home,
      '-ws-app-deleted-feature',
      'cccc3333-0000-0000-0000-000000000003',
      sessionLines(deletedCwd)
    )

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: repoRoot, repoId: 'repo-1', worktreeId: null })
    )

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ repoId: 'repo-1', worktreeId: null, cwd: deletedCwd })
  })

  it('does not attribute a sibling directory sharing a path prefix (whole-segment safety)', async () => {
    const home = await makeHome()
    const tracked = await makeWorktree(home, 'code', 'app')
    const sibling = await makeWorktree(home, 'code', 'app-internal')
    await writeSession(
      home,
      '-code-app-internal',
      'dddd4444-0000-0000-0000-000000000004',
      sessionLines(sibling)
    )

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: tracked, repoId: 'repo-1', worktreeId: 'wt-1' })
    )

    expect(sessions).toEqual([])
  })

  it('resolves a symlinked cwd to its tracked real path (AR-14)', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    const link = join(home, 'link-to-feature')
    await symlink(worktree, link)
    await writeSession(
      home,
      '-link-to-feature',
      'eeee5555-0000-0000-0000-000000000005',
      sessionLines(link)
    )

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
    )

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ repoId: 'repo-1', worktreeId: 'wt-1' })
  })

  it('does not attribute a ".." traversal cwd that resolves outside the roots', async () => {
    const home = await makeHome()
    const repoA = await makeWorktree(home, 'code', 'repo-a')
    await makeWorktree(home, 'code', 'repo-b')
    const traversal = join(repoA, '..', 'repo-b')
    await writeSession(
      home,
      '-code-repo-a',
      'ffff6666-0000-0000-0000-000000000006',
      sessionLines(traversal)
    )

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: repoA, repoId: 'repo-1', worktreeId: 'wt-1' })
    )

    expect(sessions).toEqual([])
  })

  it('drops untracked and cwd-less sessions', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    const elsewhere = await makeWorktree(home, 'elsewhere')
    await writeSession(
      home,
      '-elsewhere',
      'aaaa7777-0000-0000-0000-000000000007',
      sessionLines(elsewhere)
    )
    await writeSession(
      home,
      '-ws-app-feature',
      'bbbb8888-0000-0000-0000-000000000008',
      sessionLines(null)
    )

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
    )

    expect(sessions).toEqual([])
  })

  it('returns an empty list when ~/.claude/projects is absent', async () => {
    const home = await makeHome()
    const { ClaudeSessionHistoryProvider } = await loadModules(home)

    await expect(
      new ClaudeSessionHistoryProvider().listSessions(
        scopeOf({ path: join(home, 'ws'), repoId: 'repo-1', worktreeId: 'wt-1' })
      )
    ).resolves.toEqual([])
  })

  it('still lists a session whose trailing line is torn mid-append', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    await writeSession(
      home,
      '-ws-app-feature',
      'cccc9999-0000-0000-0000-000000000009',
      `${sessionLines(worktree)}\n{"type":"assistant","cwd":"/worksp`
    )

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
    )

    expect(sessions).toHaveLength(1)
  })

  it('drops unparseable and empty files without throwing', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    await writeSession(
      home,
      '-ws-app-feature',
      'dddd0000-0000-0000-0000-00000000000a',
      'not json\n{"torn'
    )
    await writeSession(home, '-ws-app-feature', 'eeee0000-0000-0000-0000-00000000000b', '')

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    await expect(
      new ClaudeSessionHistoryProvider().listSessions(
        scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
      )
    ).resolves.toEqual([])
  })

  it('dedupes the same sessionId across files, keeping the latest activity', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    const sessionId = 'ffff0000-0000-0000-0000-00000000000c'
    const older = await writeSession(home, '-ws-app-old', sessionId, sessionLines(worktree))
    const newer = await writeSession(home, '-ws-app-feature', sessionId, sessionLines(worktree))
    await utimes(older, new Date('2026-06-08T10:00:00Z'), new Date('2026-06-08T10:00:00Z'))
    await utimes(newer, new Date('2026-06-09T10:00:00Z'), new Date('2026-06-09T10:00:00Z'))

    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    const sessions = await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
    )

    expect(sessions).toHaveLength(1)
    expect(sessions[0].lastActivity).toBe('2026-06-09T10:00:00.000Z')
  })

  it('serves unchanged files from the mtime/size cache without re-reading lines', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    const file = await writeSession(
      home,
      '-ws-app-feature',
      'aaaa0000-0000-0000-0000-00000000000d',
      sessionLines(worktree)
    )

    const { ClaudeSessionHistoryProvider, createLocalClaudeStoreFsAccessor } =
      await loadModules(home)
    const local = createLocalClaudeStoreFsAccessor()
    const readLines = vi.fn(local.readLines)
    const provider = new ClaudeSessionHistoryProvider({ ...local, readLines })
    const scope = scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })

    const first = await provider.listSessions(scope)
    expect(readLines).toHaveBeenCalledTimes(1)

    const second = await provider.listSessions(scope)
    expect(readLines).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)

    // A content change invalidates the cache entry.
    await writeFile(file, sessionLines(worktree, '2026-06-09T12:00:00.000Z'))
    await utimes(file, new Date('2026-06-09T12:00:00Z'), new Date('2026-06-09T12:00:00Z'))
    await provider.listSessions(scope)
    expect(readLines).toHaveBeenCalledTimes(2)
  })

  it('skips a file that disappears between listing and stat', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    const kept = await writeSession(
      home,
      '-ws-app-feature',
      'bbbb0000-0000-0000-0000-00000000000e',
      sessionLines(worktree)
    )

    const { ClaudeSessionHistoryProvider, createLocalClaudeStoreFsAccessor } =
      await loadModules(home)
    const local = createLocalClaudeStoreFsAccessor()
    const provider = new ClaudeSessionHistoryProvider({
      ...local,
      listSessionFiles: async () => [kept, join(home, '.claude', 'projects', 'gone', 'gone.jsonl')]
    })

    const sessions = await provider.listSessions(
      scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
    )
    expect(sessions.map((s) => s.sessionId)).toEqual(['bbbb0000-0000-0000-0000-00000000000e'])
  })

  it('leaves the ~/.claude fixture tree byte-identical after a scan (read-only, NFR-2)', async () => {
    const home = await makeHome()
    const worktree = await makeWorktree(home, 'ws', 'app', 'feature')
    await writeSession(
      home,
      '-ws-app-feature',
      'cccc0000-0000-0000-0000-00000000000f',
      sessionLines(worktree)
    )
    await writeSession(home, '-elsewhere', 'dddd0000-0000-0000-0000-000000000010', 'not json')

    const snapshot = async (): Promise<Record<string, { mtimeMs: number; size: number }>> => {
      const claudeRoot = join(home, '.claude')
      const entries = await readdir(claudeRoot, { recursive: true, withFileTypes: true })
      const result: Record<string, { mtimeMs: number; size: number }> = {}
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue
        }
        const filePath = join(entry.parentPath, entry.name)
        const fileStat = await stat(filePath)
        result[filePath] = { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
      }
      return result
    }

    const before = await snapshot()
    const { ClaudeSessionHistoryProvider } = await loadModules(home)
    await new ClaudeSessionHistoryProvider().listSessions(
      scopeOf({ path: worktree, repoId: 'repo-1', worktreeId: 'wt-1' })
    )
    await expect(snapshot()).resolves.toEqual(before)
  })
})

describe('ClaudeSessionHistoryProvider.readTranscript', () => {
  it('returns the defensive empty model until Story 2.1', async () => {
    const home = await makeHome()
    const { ClaudeSessionHistoryProvider } = await loadModules(home)

    await expect(new ClaudeSessionHistoryProvider().readTranscript('any-id')).resolves.toEqual({
      turns: [],
      schemaRecognized: false
    })
  })
})
