import React, { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useNow } from '@/components/dashboard/useNow'
import { SessionHistoryRow } from './SessionHistoryRow'
import { SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT } from './WorktreeCardAgents'
import type { SessionMeta } from '../../../../shared/session-history-types'

type Props = {
  repoId: string
}

const SHOWN_COUNT_FALLBACK = 5

// Why: defensive renderer-side re-clamp — a hand-edited settings.json bypasses
// the persistence clamp (deferred-work.md), so never trust the raw value.
function clampShownCount(raw: number | undefined): number {
  const rounded = Math.round(raw ?? SHOWN_COUNT_FALLBACK)
  if (!Number.isFinite(rounded) || rounded < 1) {
    return SHOWN_COUNT_FALLBACK
  }
  return Math.min(50, Math.max(1, rounded))
}

function stopBubble(e: React.SyntheticEvent): void {
  e.stopPropagation()
}

// Why: the surrounding worktree list handles Enter/Space as row activation;
// nested buttons keep those keys local (the compact-agents idiom).
function stopActivationKeyPropagation(e: React.KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation()
  }
}

// Why: collapsing/expanding changes card height; the virtualizer would
// otherwise scroll-adjust and visually jump (the compact-agents precedent).
function dispatchSuppressScrollAdjustment(): void {
  window.dispatchEvent(new CustomEvent(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT))
}

export function SessionHistoryList({ repoId }: Props): React.JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const sessions = useAppStore((s) => s.sessionHistorySessions)
  const loaded = useAppStore((s) => s.sessionHistoryLoaded)
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)

  const visible = useMemo(() => sessions.filter((s) => s.repoId === repoId), [sessions, repoId])
  const pastSessions = useMemo(() => visible.filter((s) => !s.isLive), [visible])

  if (settings?.sessionHistoryEnabled !== true || !loaded || visible.length === 0) {
    return null
  }

  const collapseKey = `sessionHistory:${repoId}`
  const expanded = !collapsedGroups.has(collapseKey)
  const shownCount = clampShownCount(settings.sessionHistoryShownCount)

  return (
    <div
      className="mt-1 flex flex-col gap-0.5"
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
    >
      <button
        type="button"
        draggable={false}
        className="flex h-6 w-full min-w-0 items-center gap-1 rounded-sm px-1 text-left text-[11px] font-medium leading-none text-muted-foreground hover:bg-worktree-sidebar-accent/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring dark:hover:bg-worktree-sidebar-foreground/[0.035]"
        aria-expanded={expanded}
        onClick={() => {
          dispatchSuppressScrollAdjustment()
          toggleCollapsedGroup(collapseKey)
        }}
        onKeyDown={stopActivationKeyPropagation}
        onMouseDown={stopBubble}
        onPointerDown={stopBubble}
        onDragStart={stopBubble}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 transition-transform duration-150',
            expanded && 'rotate-90'
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          {translate(
            'auto.components.sidebar.SessionHistoryList.a7ccb25750',
            'Past sessions · {{value0}}',
            { value0: pastSessions.length }
          )}
        </span>
      </button>
      {expanded &&
        (pastSessions.length === 0 ? (
          <div className="px-1 text-[11px] text-muted-foreground/70">
            {translate(
              'auto.components.sidebar.SessionHistoryList.6e31fb3515',
              'No past sessions yet'
            )}
          </div>
        ) : (
          <SessionHistoryListRows sessions={pastSessions} shownCount={shownCount} />
        ))}
    </div>
  )
}

type RowsProps = {
  sessions: SessionMeta[]
  shownCount: number
}

// Why: useNow's 30s tick mounts only while rows are visible (the
// WorktreeCardAgents two-component gating pattern keeps idle cards timer-free).
function SessionHistoryListRows({ sessions, shownCount }: RowsProps): React.JSX.Element {
  const now = useNow(30_000)
  const [tailExpanded, setTailExpanded] = useState(false)

  const hasTail = sessions.length > shownCount
  const shown = tailExpanded ? sessions : sessions.slice(0, shownCount)

  return (
    <>
      {shown.map((session) => (
        <SessionHistoryRow key={session.sessionId} session={session} now={now} />
      ))}
      {hasTail && (
        <button
          type="button"
          draggable={false}
          className="flex h-6 w-full min-w-0 items-center rounded-sm px-1 text-left text-[11px] leading-none text-muted-foreground/70 hover:bg-worktree-sidebar-accent/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring dark:hover:bg-worktree-sidebar-foreground/[0.035]"
          onClick={() => {
            dispatchSuppressScrollAdjustment()
            setTailExpanded((prev) => !prev)
          }}
          onKeyDown={stopActivationKeyPropagation}
          onMouseDown={stopBubble}
          onPointerDown={stopBubble}
          onDragStart={stopBubble}
        >
          {tailExpanded
            ? translate('auto.components.sidebar.SessionHistoryList.e86ce0aea3', 'Show fewer')
            : translate(
                'auto.components.sidebar.SessionHistoryList.3290349e45',
                'Show {{value0}} more',
                { value0: sessions.length - shownCount }
              )}
        </button>
      )}
    </>
  )
}
