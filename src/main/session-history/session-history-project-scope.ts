import type { GlobalSettings, Repo } from '../../shared/types'
import { buildKnownOrcaWorkspaceLayouts } from '../../shared/worktree-ownership'
import {
  getRuntimePathBasename,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import type {
  SessionHistoryProjectScope,
  SessionHistoryScopeRoot
} from '../../shared/session-history-types'

export type SessionHistoryRepoInput = Pick<
  Repo,
  'id' | 'path' | 'connectionId' | 'worktreeBasePath'
>

// Why: structural subset of UsageWorktreeRef — keeps the builder a pure
// function over plain data, no dependency on the usage store wiring.
export type SessionHistoryWorktreeInput = {
  worktreeId: string
  path: string
}

export function isFilesystemRootPath(path: string): boolean {
  const normalized = normalizeRuntimePathForComparison(path)
  return normalized === '' || normalized === '/' || /^[a-z]:\/?$/.test(normalized)
}

export function buildSessionHistoryProjectScope(
  repos: readonly SessionHistoryRepoInput[],
  worktreesByRepo: ReadonlyMap<string, readonly SessionHistoryWorktreeInput[]>,
  settings: Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'>
): SessionHistoryProjectScope {
  // Why: Phase 1 reads only the local ~/.claude store, so remote repos cannot
  // own any discovered session (AR-9; mirrors loadKnownUsageWorktreesByRepo).
  const localRepos = repos.filter((repo) => !repo.connectionId)
  const roots: SessionHistoryScopeRoot[] = []
  const seenPaths = new Set<string>()

  const addRoot = (root: SessionHistoryScopeRoot): void => {
    // Why: a filesystem-root scope root would contain every absolute path
    // (isContainedPath parent-'' quirk, see deferred-work.md) — never emit one.
    if (isFilesystemRootPath(root.path)) {
      return
    }
    const key = normalizeRuntimePathForComparison(root.path)
    if (seenPaths.has(key)) {
      return
    }
    seenPaths.add(key)
    roots.push(root)
  }

  // Live worktree roots first so they win the dedupe over repo-level roots.
  for (const repo of localRepos) {
    for (const worktree of worktreesByRepo.get(repo.id) ?? []) {
      addRoot({ path: worktree.path, repoId: repo.id, worktreeId: worktree.worktreeId })
    }
  }

  // Why: deleted worktrees vanish from WorktreeMeta, but nested-layout paths
  // are <layout>/<repoName>/<workspace> — a repo-level root at
  // <layout>/<repoName> still contains them (FR-5). Flat layouts mix
  // workspaces of different repos in one dir, so they are not attributable.
  // Why: two repos sharing a basename produce the same <layout>/<name> root;
  // attributing it to either would leak sessions cross-repo (AC-3) — track
  // the owner per path and drop roots that become ambiguous.
  const repoRootOwnerByPath = new Map<string, string | null>()
  const repoRootCandidates: SessionHistoryScopeRoot[] = []
  for (const repo of localRepos) {
    const repoName = getRuntimePathBasename(repo.path).replace(/\.git$/i, '')
    if (!repoName) {
      continue
    }
    for (const layout of buildKnownOrcaWorkspaceLayouts(settings, repo)) {
      if (!layout.nestWorkspaces) {
        continue
      }
      const path = resolveRuntimePath(layout.path, repoName)
      const key = normalizeRuntimePathForComparison(path)
      const owner = repoRootOwnerByPath.get(key)
      if (owner === undefined) {
        repoRootOwnerByPath.set(key, repo.id)
        repoRootCandidates.push({ path, repoId: repo.id, worktreeId: null })
      } else if (owner !== repo.id) {
        repoRootOwnerByPath.set(key, null)
      }
    }
  }
  for (const candidate of repoRootCandidates) {
    if (repoRootOwnerByPath.get(normalizeRuntimePathForComparison(candidate.path)) !== null) {
      addRoot(candidate)
    }
  }

  return { roots }
}
