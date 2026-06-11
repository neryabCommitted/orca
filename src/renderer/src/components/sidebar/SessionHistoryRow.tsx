import React from 'react'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from './worktree-card-compact-agents'
import type { SessionMeta } from '../../../../shared/session-history-types'

type Props = {
  session: SessionMeta
  now: number
  /** Left unwired in Phase 1 — story 2.2 threads the Preview activation. */
  onActivate?: (sessionId: string) => void
}

// Why: the surrounding worktree list handles Enter/Space as row activation.
// Focused nested buttons need those keys to stay local (the
// stopActivationKeyPropagation idiom from worktree-card-compact-agents).
function stopActivationKeyPropagation(e: React.KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation()
  }
}

function stopPointerPropagation(e: React.SyntheticEvent): void {
  e.stopPropagation()
}

export function SessionHistoryRow({ session, now, onActivate }: Props): React.JSX.Element {
  const lastActivityMs = new Date(session.lastActivity).getTime()
  const age = Number.isFinite(lastActivityMs) ? formatShortTimeAgo(lastActivityMs, now) : null
  const isUserRenamed = session.titleSource === 'userRename'

  return (
    <button
      type="button"
      draggable={false}
      className="flex h-6 w-full min-w-0 items-center gap-1 rounded-sm px-1 text-left text-[11px] leading-none text-muted-foreground hover:bg-worktree-sidebar-accent/55 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring dark:hover:bg-worktree-sidebar-foreground/[0.035]"
      title={session.title}
      aria-label={translate(
        'auto.components.sidebar.SessionHistoryRow.4932f1fca2',
        '{{value0}} past session',
        { value0: session.title }
      )}
      onClick={() => onActivate?.(session.sessionId)}
      onKeyDown={stopActivationKeyPropagation}
      onMouseDown={stopPointerPropagation}
      onPointerDown={stopPointerPropagation}
      onDragStart={stopPointerPropagation}
    >
      {/* Why: hollow ring = "past" — shape-distinct from the filled live dots
          (DESIGN.md), same sm AgentStateDot footprint, no new hue. */}
      <span className="flex h-2.5 w-2.5 shrink-0 items-center justify-center" aria-hidden>
        <span className="size-1.5 rounded-full border-[1.5px] border-muted-foreground/70 bg-transparent" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        {isUserRenamed ? (
          <>
            <span className="text-foreground/85">{session.title}</span>
            <span className="text-muted-foreground/60"> ✎</span>
          </>
        ) : (
          session.title
        )}
      </span>
      {age !== null && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{age}</span>
      )}
    </button>
  )
}
