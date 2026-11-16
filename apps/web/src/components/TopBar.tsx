import { useState } from 'react'
import type { CommitOutcome, SaveState as SaveStateValue } from '../hooks/useDocument'
import { PANES_QUERY, useMediaQuery } from '../hooks/useMediaQuery'
import { basename, displayName } from '../lib/paths'
import { useSession } from '../state/session'
import { Icon, type IconName } from './Icon'
import { MenuItem } from './Menu'
import { MoreMenu } from './PageHeader'
import { SaveState } from './SaveState'
import { SaveVersion } from './SaveVersion'
import { ShareMenu } from './ShareMenu'

/** 'history', 'properties', or a panel the page adds (see `extraPanels`). */
export type SidePanel = string | null

/** A page-specific side panel's toggle, shown before History. */
export interface PanelToggle {
  id: string
  label: string
  icon: IconName
  testId?: string
}

interface TopBarProps {
  space: string
  path: string
  compact: boolean
  /** The doc's own name (its heading). A phone shows it where the file name would be. */
  title?: string
  save: {
    state: SaveStateValue
    isNew: boolean
    lastCommittedAt: number | null
    error: string | null
  }
  reading: boolean
  onToggleReading: () => void
  panel: SidePanel
  onTogglePanel: (panel: string) => void
  extraPanels?: PanelToggle[]
  onSaveVersion: (label: string) => Promise<CommitOutcome>
  beforeShare: () => Promise<unknown>
  getText: () => string
  onOpenDrawer: () => void
  /** Offered after a retitle: move the file to the new title's slug, or keep its name. */
  rename: { to: string; onRename: () => void; onKeep: () => void } | null
  /** Shows "Attach a file" (Hotsauce Files' picker). */
  onAttachFile?: () => void
  /** A team item's conversation: how many comments, and the way down to it. */
  comments?: { count: number; onOpen: () => void }
}

export function TopBar(props: TopBarProps) {
  const { space, path, compact } = props
  const session = useSession()
  // Narrower than PANES_QUERY (an upright iPad), labels would push Share off the screen.
  const iconOnly = !useMediaQuery(PANES_QUERY) || compact
  const starred = session.isStarred(space, path)
  const folders = path.split('/').slice(1, -1)
  const [naming, setNaming] = useState(false)

  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-1 border-b border-ash/70 bg-paper/80 px-2 backdrop-blur-sm md:gap-2 md:px-4">
      {compact ? (
        <IconButton icon="menu" label="Open sidebar" onClick={props.onOpenDrawer} />
      ) : null}

      <nav aria-label="Breadcrumbs" className="flex min-w-10 flex-1 items-center gap-1 text-sm">
        {compact ? null : (
          <>
            <span className="shrink-0 text-ink-faint">{session.spaceLabel(space)}</span>
            {folders.map((folder, i) => (
              <span
                key={folders.slice(0, i + 1).join('/')}
                className="flex min-w-0 items-center gap-1 text-ink-faint"
              >
                <Icon name="chevron" className="size-3 shrink-0" />
                <span className="truncate">{folder}</span>
              </span>
            ))}
            <Icon name="chevron" className="size-3 shrink-0 text-ink-faint" />
          </>
        )}
        <span
          className="truncate font-medium text-ink"
          aria-current="page"
          data-testid="doc-title"
          title={displayName(path)}
        >
          {compact && props.title ? props.title : displayName(path)}
        </span>
      </nav>

      {props.rename ? (
        <div className="flex min-w-0 shrink items-center rounded-full border border-ash bg-paper-raised/70 pl-2.5 text-xs">
          <button
            type="button"
            data-testid="rename-to-title"
            onClick={props.rename.onRename}
            className="truncate text-ember-strong hover:underline"
          >
            {compact ? 'Rename file' : `Rename file to ${basename(props.rename.to)}`}
          </button>
          <button
            type="button"
            aria-label="Keep the file name"
            title="Keep the file name"
            onClick={props.rename.onKeep}
            className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-faint hover:text-ink"
          >
            <Icon name="close" className="size-3" />
          </button>
        </div>
      ) : null}

      <SaveState {...props.save} compact={compact} />

      {compact ? (
        <div className="flex shrink-0 items-center gap-0.5">
          <ShareMenu
            space={space}
            path={path}
            beforeShare={props.beforeShare}
            getText={props.getText}
          />
          <MoreMenu>
            {(close) => {
              const pick = (run: () => void) => () => {
                close()
                run()
              }
              return (
                <>
                  {props.extraPanels?.map((toggle) => (
                    <MenuItem
                      key={toggle.id}
                      icon={toggle.icon}
                      {...(toggle.testId ? { testId: toggle.testId } : {})}
                      onSelect={pick(() => props.onTogglePanel(toggle.id))}
                    >
                      {toggle.label}
                    </MenuItem>
                  ))}
                  {props.comments ? (
                    <MenuItem
                      icon="chat"
                      testId="comments-toggle"
                      onSelect={pick(props.comments.onOpen)}
                    >
                      {props.comments.count === 0
                        ? 'Comments'
                        : `Comments (${props.comments.count})`}
                    </MenuItem>
                  ) : null}
                  {props.onAttachFile ? (
                    <MenuItem
                      icon="paperclip"
                      testId="attach-file"
                      onSelect={pick(props.onAttachFile)}
                    >
                      Attach a file
                    </MenuItem>
                  ) : null}
                  <MenuItem icon="star" onSelect={pick(() => void session.toggleStar(space, path))}>
                    {starred ? 'Remove from Starred' : 'Add to Starred'}
                  </MenuItem>
                  <MenuItem
                    icon="book"
                    testId="reading-toggle"
                    onSelect={pick(props.onToggleReading)}
                  >
                    {props.reading ? 'Back to editing' : 'Reading view'}
                  </MenuItem>
                  <MenuItem
                    icon="history"
                    testId="history-toggle"
                    onSelect={pick(() => props.onTogglePanel('history'))}
                  >
                    History
                  </MenuItem>
                  <MenuItem
                    icon="flag"
                    testId="save-version"
                    onSelect={pick(() => setNaming(true))}
                  >
                    Save version
                  </MenuItem>
                </>
              )
            }}
          </MoreMenu>
          <SaveVersion onSave={props.onSaveVersion} asked={naming} onAsked={setNaming} />
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          {props.extraPanels?.map((toggle) => (
            <IconButton
              key={toggle.id}
              icon={toggle.icon}
              label={toggle.label}
              {...(toggle.testId ? { testId: toggle.testId } : {})}
              pressed={props.panel === toggle.id}
              onClick={() => props.onTogglePanel(toggle.id)}
            />
          ))}
          {props.comments ? (
            <button
              type="button"
              aria-label={
                props.comments.count === 0 ? 'Comments' : `Comments (${props.comments.count})`
              }
              title="Comments"
              data-testid="comments-toggle"
              onClick={props.comments.onOpen}
              className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-ink-soft transition-colors hover:bg-paper-sunk hover:text-ink"
            >
              <Icon name="chat" className="size-4" />
              {props.comments.count > 0 ? (
                <span className="text-xs font-medium tabular-nums">{props.comments.count}</span>
              ) : null}
            </button>
          ) : null}
          {props.onAttachFile ? (
            <IconButton
              icon="paperclip"
              label="Attach a file"
              testId="attach-file"
              onClick={props.onAttachFile}
            />
          ) : null}
          <IconButton
            icon="star"
            label={starred ? 'Remove from Starred' : 'Add to Starred'}
            pressed={starred}
            onClick={() => void session.toggleStar(space, path)}
          />
          <IconButton
            icon="book"
            label="Reading view"
            testId="reading-toggle"
            pressed={props.reading}
            onClick={props.onToggleReading}
          />
          <IconButton
            icon="history"
            label="History"
            testId="history-toggle"
            pressed={props.panel === 'history'}
            onClick={() => props.onTogglePanel('history')}
          />
          {compact ? null : (
            <IconButton
              icon="sliders"
              label="Properties"
              pressed={props.panel === 'properties'}
              onClick={() => props.onTogglePanel('properties')}
            />
          )}
          <SaveVersion onSave={props.onSaveVersion} iconOnly={iconOnly} />
          <ShareMenu
            space={space}
            path={path}
            beforeShare={props.beforeShare}
            getText={props.getText}
            iconOnly={iconOnly}
          />
        </div>
      )}
    </header>
  )
}

export function IconButton({
  icon,
  label,
  onClick,
  pressed,
  testId,
}: {
  icon: IconName
  label: string
  onClick: () => void
  pressed?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors ${
        pressed
          ? 'bg-ember-wash text-ember-strong'
          : 'text-ink-soft hover:bg-paper-sunk hover:text-ink'
      }`}
    >
      <Icon name={icon} className={`size-4 ${icon === 'star' && pressed ? 'fill-current' : ''}`} />
    </button>
  )
}
