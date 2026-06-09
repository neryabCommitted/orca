import { mkdtemp, mkdir, rm, symlink, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
// Same assertions ran green against claude-usage/scanner before extraction;
// re-pointed here to prove the claude-store primitives are byte-identical.
import {
  canonicalizePath,
  findContainingWorktree,
  isContainedPath,
  normalizeComparablePath
} from './claude-store-paths'

type WorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

const tempRoots: string[] = []

async function makeTempDir(): Promise<string> {
  // realpath the temp root so assertions survive symlinked tmp dirs (e.g. macOS /tmp).
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-claude-store-paths-')))
  tempRoots.push(root)
  return root
}

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    run()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

function ref(path: string): WorktreeRef {
  return { repoId: `repo:${path}`, worktreeId: `wt:${path}`, path, displayName: path }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('normalizeComparablePath', () => {
  it('converts backslashes to forward slashes on every platform', () => {
    withPlatform('linux', () => {
      expect(normalizeComparablePath('C:\\Users\\dev\\repo')).toBe('C:/Users/dev/repo')
    })
  })

  it('does not lowercase on non-win32 platforms', () => {
    withPlatform('linux', () => {
      expect(normalizeComparablePath('/Workspace/Repo-A')).toBe('/Workspace/Repo-A')
    })
  })

  it('lowercases on win32 for case-insensitive comparison', () => {
    withPlatform('win32', () => {
      expect(normalizeComparablePath('/Workspace/Repo-A')).toBe('/workspace/repo-a')
    })
  })
})

describe('isContainedPath', () => {
  it('matches an exact path', () => {
    expect(isContainedPath('/workspace/repo-a', '/workspace/repo-a')).toBe(true)
  })

  it('matches a child path nested under the parent', () => {
    expect(isContainedPath('/workspace/repo-a', '/workspace/repo-a/packages/app')).toBe(true)
  })

  it('respects whole-segment boundaries (no prefix-leak)', () => {
    // '/code/app' must NOT contain '/code/app-internal'.
    expect(isContainedPath('/code/app', '/code/app-internal')).toBe(false)
  })

  it('strips trailing slashes on both sides before comparing', () => {
    expect(isContainedPath('/workspace/repo-a/', '/workspace/repo-a/')).toBe(true)
    expect(isContainedPath('/workspace/repo-a/', '/workspace/repo-a/sub')).toBe(true)
  })

  it('normalizes backslashes before comparing', () => {
    expect(isContainedPath('\\workspace\\repo-a', '\\workspace\\repo-a\\sub')).toBe(true)
  })
})

describe('canonicalizePath', () => {
  it('resolves a real path through realpath then normalizes it', async () => {
    const root = await makeTempDir()
    const target = join(root, 'repo-a')
    await mkdir(target)
    expect(await canonicalizePath(target)).toBe(normalizeComparablePath(await realpath(target)))
  })

  it('resolves a symlink to its real target', async () => {
    const root = await makeTempDir()
    const target = join(root, 'repo-a')
    const link = join(root, 'link-to-repo-a')
    await mkdir(target)
    await symlink(target, link)
    expect(await canonicalizePath(link)).toBe(normalizeComparablePath(target))
  })

  it('falls back to a normalized path when realpath throws', async () => {
    const missing = '/nonexistent/orca/repo-x'
    expect(await canonicalizePath(missing)).toBe(normalizeComparablePath(missing))
  })
})

describe('findContainingWorktree', () => {
  const repoA = ref('/workspace/repo-a')
  const lookup = new Map([[repoA.path, repoA]])

  it('returns the exact-match worktree via the fast path', () => {
    expect(findContainingWorktree('/workspace/repo-a', lookup)).toBe(repoA)
  })

  it('attributes a nested cwd to the containing worktree', () => {
    expect(findContainingWorktree('/workspace/repo-a/packages/app', lookup)).toBe(repoA)
  })

  it('returns null when no worktree contains the cwd', () => {
    expect(findContainingWorktree('/outside/repo-b', lookup)).toBeNull()
  })

  it('prefers the longest containing path when worktrees overlap', () => {
    const outer = ref('/workspace/repo')
    const inner = ref('/workspace/repo/sub')
    const overlap = new Map([
      [outer.path, outer],
      [inner.path, inner]
    ])
    expect(findContainingWorktree('/workspace/repo/sub/src', overlap)).toBe(inner)
  })
})

describe('containment does not leak outside the worktree (adversarial)', () => {
  it('does not attribute a ".." traversal that resolves to a sibling repo', async () => {
    const root = await makeTempDir()
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')
    await mkdir(repoA)
    await mkdir(repoB)
    const lookup = new Map([[await canonicalizePath(repoA), ref(repoA)]])

    const traversed = await canonicalizePath(join(repoA, '..', 'repo-b'))
    expect(findContainingWorktree(traversed, lookup)).toBeNull()
  })

  it('does not attribute a symlink that escapes the worktree tree', async () => {
    const root = await makeTempDir()
    const repoA = join(root, 'repo-a')
    const repoB = join(root, 'repo-b')
    await mkdir(repoA)
    await mkdir(repoB)
    const escape = join(repoA, 'escape')
    await symlink(repoB, escape)
    const lookup = new Map([[await canonicalizePath(repoA), ref(repoA)]])

    const escaped = await canonicalizePath(escape)
    expect(findContainingWorktree(escaped, lookup)).toBeNull()
  })

  it('does not attribute an absolute path injected outside the worktree', async () => {
    const root = await makeTempDir()
    const repoA = join(root, 'repo-a')
    await mkdir(repoA)
    const lookup = new Map([[await canonicalizePath(repoA), ref(repoA)]])

    expect(findContainingWorktree(normalizeComparablePath('/etc'), lookup)).toBeNull()
  })
})
