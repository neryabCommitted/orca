import { describe, expect, it } from 'vitest'
import { buildSessionHistoryProjectScope } from './session-history-project-scope'
import { findContainingWorktree, normalizeComparablePath } from '../claude-store/claude-store-paths'
import type { SessionHistoryScopeRoot } from '../../shared/session-history-types'

const nestedSettings = { workspaceDir: '/ws', nestWorkspaces: true, workspaceDirHistory: [] }
const flatSettings = { workspaceDir: '/ws', nestWorkspaces: false, workspaceDirHistory: [] }

function buildLookup(roots: SessionHistoryScopeRoot[]): Map<string, SessionHistoryScopeRoot> {
  const lookup = new Map<string, SessionHistoryScopeRoot>()
  for (const root of roots) {
    lookup.set(normalizeComparablePath(root.path), root)
  }
  return lookup
}

describe('buildSessionHistoryProjectScope', () => {
  it('emits a root per live worktree', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app' }],
      new Map([
        [
          'repo-1',
          [
            { worktreeId: 'repo-1::/code/app', path: '/code/app' },
            { worktreeId: 'wt-1', path: '/ws/app/feature-y' }
          ]
        ]
      ]),
      nestedSettings
    )

    expect(scope.roots).toContainEqual({
      path: '/code/app',
      repoId: 'repo-1',
      worktreeId: 'repo-1::/code/app'
    })
    expect(scope.roots).toContainEqual({
      path: '/ws/app/feature-y',
      repoId: 'repo-1',
      worktreeId: 'wt-1'
    })
  })

  it('resolves a deleted-worktree cwd via the nested-layout repo root with null worktreeId', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app' }],
      new Map([['repo-1', [{ worktreeId: 'repo-1::/code/app', path: '/code/app' }]]]),
      nestedSettings
    )

    const resolved = findContainingWorktree('/ws/app/deleted-feature', buildLookup(scope.roots))
    expect(resolved).toEqual({ path: '/ws/app', repoId: 'repo-1', worktreeId: null })
  })

  it('prefers the live worktree over the repo-level root (longest-path-first)', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app' }],
      new Map([
        [
          'repo-1',
          [
            { worktreeId: 'repo-1::/code/app', path: '/code/app' },
            { worktreeId: 'wt-1', path: '/ws/app/feature-y' }
          ]
        ]
      ]),
      nestedSettings
    )

    const resolved = findContainingWorktree('/ws/app/feature-y/src', buildLookup(scope.roots))
    expect(resolved?.worktreeId).toBe('wt-1')
  })

  it('emits no repo-level root for flat layouts', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app' }],
      new Map([['repo-1', [{ worktreeId: 'repo-1::/code/app', path: '/code/app' }]]]),
      flatSettings
    )

    expect(scope.roots).toEqual([
      { path: '/code/app', repoId: 'repo-1', worktreeId: 'repo-1::/code/app' }
    ])
    expect(findContainingWorktree('/ws/deleted-feature', buildLookup(scope.roots))).toBeNull()
  })

  it('derives the repo-level root from a repo-scoped worktreeBasePath', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app', worktreeBasePath: '../wt' }],
      new Map([['repo-1', [{ worktreeId: 'repo-1::/code/app', path: '/code/app' }]]]),
      { ...nestedSettings, workspaceDir: '' }
    )

    expect(scope.roots).toContainEqual({ path: '/code/wt/app', repoId: 'repo-1', worktreeId: null })
  })

  it('excludes remote repos entirely', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app', connectionId: 'ssh-1' }],
      new Map([['repo-1', [{ worktreeId: 'repo-1::/code/app', path: '/code/app' }]]]),
      nestedSettings
    )

    expect(scope.roots).toEqual([])
  })

  it('strips a trailing .git from the repo name for the layout root', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app.git' }],
      new Map([['repo-1', [{ worktreeId: 'repo-1::/code/app.git', path: '/code/app.git' }]]]),
      nestedSettings
    )

    expect(scope.roots).toContainEqual({ path: '/ws/app', repoId: 'repo-1', worktreeId: null })
  })

  it('dedupes roots by path, keeping the live worktree entry', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/code/app' }],
      new Map([['repo-1', [{ worktreeId: 'wt-1', path: '/ws/app' }]]]),
      nestedSettings
    )

    const wsAppRoots = scope.roots.filter((root) => root.path === '/ws/app')
    expect(wsAppRoots).toEqual([{ path: '/ws/app', repoId: 'repo-1', worktreeId: 'wt-1' }])
  })

  it('drops a repo-level root claimed by two repos sharing a basename', () => {
    const scope = buildSessionHistoryProjectScope(
      [
        { id: 'repo-1', path: '/code/a/app' },
        { id: 'repo-2', path: '/code/b/app' }
      ],
      new Map([
        ['repo-1', [{ worktreeId: 'wt-1', path: '/code/a/app' }]],
        ['repo-2', [{ worktreeId: 'wt-2', path: '/code/b/app' }]]
      ]),
      nestedSettings
    )

    // The shared <layout>/app root cannot be attributed to either repo.
    expect(scope.roots.filter((root) => root.path === '/ws/app')).toEqual([])
    expect(scope.roots).toContainEqual({
      path: '/code/a/app',
      repoId: 'repo-1',
      worktreeId: 'wt-1'
    })
    expect(scope.roots).toContainEqual({
      path: '/code/b/app',
      repoId: 'repo-2',
      worktreeId: 'wt-2'
    })
  })

  it('never emits a filesystem-root scope root', () => {
    const scope = buildSessionHistoryProjectScope(
      [{ id: 'repo-1', path: '/' }],
      new Map([['repo-1', [{ worktreeId: 'repo-1::/', path: '/' }]]]),
      nestedSettings
    )

    expect(scope.roots.some((root) => normalizeComparablePath(root.path) === '/')).toBe(false)
  })

  it('ignores worktree lists for repos not in the repo set', () => {
    const scope = buildSessionHistoryProjectScope(
      [],
      new Map([['ghost-repo', [{ worktreeId: 'wt-1', path: '/ws/app/feature-y' }]]]),
      nestedSettings
    )

    expect(scope.roots).toEqual([])
  })
})
