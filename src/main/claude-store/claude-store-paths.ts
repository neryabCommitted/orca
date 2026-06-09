import { realpath } from 'fs/promises'

export function normalizeComparablePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    const resolved = await realpath(pathValue)
    return normalizeComparablePath(resolved)
  } catch {
    return normalizeComparablePath(pathValue)
  }
}

export function isContainedPath(parentPath: string, childPath: string): boolean {
  const parent = normalizeComparablePath(parentPath).replace(/\/+$/, '')
  const child = normalizeComparablePath(childPath).replace(/\/+$/, '')
  return child === parent || child.startsWith(`${parent}/`)
}

// Why: containment is checked per turn against the same lookup; cache the
// length-sorted entries by lookup identity so each scan sorts once.
const sortedEntriesByLookup = new WeakMap<object, [string, unknown][]>()

function getSortedEntries<T>(lookup: Map<string, T>): [string, T][] {
  const cached = sortedEntriesByLookup.get(lookup)
  if (cached) {
    return cached as [string, T][]
  }
  const sorted = [...lookup.entries()].sort(
    ([leftPath], [rightPath]) => rightPath.length - leftPath.length
  )
  sortedEntriesByLookup.set(lookup, sorted)
  return sorted
}

export function findContainingWorktree<T>(cwd: string, worktreeLookup: Map<string, T>): T | null {
  const normalizedCwd = normalizeComparablePath(cwd)
  const exact = worktreeLookup.get(normalizedCwd)
  if (exact) {
    return exact
  }

  for (const [worktreePath, worktree] of getSortedEntries(worktreeLookup)) {
    if (isContainedPath(worktreePath, normalizedCwd)) {
      return worktree
    }
  }

  return null
}
