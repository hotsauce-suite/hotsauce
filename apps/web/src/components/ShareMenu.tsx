import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../api/client'
import { copyAsMarkdown, copyAsRichText } from '../lib/copyNote'
import { DOCS_ROOT, docUrl } from '../lib/paths'
import { useSession } from '../state/session'
import { FolderPicker } from './FolderPicker'
import { Icon } from './Icon'
import { below, Menu, type MenuAnchor, MenuItem } from './Menu'

interface ShareMenuProps {
  space: string
  path: string
  /** Commits pending edits first, so the shared copy is the current text. */
  beforeShare: () => Promise<unknown>
  /** The text as it is in the editor now, for the copy items. */
  getText: () => string
  iconOnly?: boolean
}

export function ShareMenu({ space, path, beforeShare, getText, iconOnly = false }: ShareMenuProps) {
  const { spaces, notify, tree } = useSession()
  const navigate = useNavigate()
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const [picking, setPicking] = useState(false)
  const isPersonal = spaces.find((s) => s.name === space)?.kind === 'personal'

  const copyLink = async () => {
    setAnchor(null)
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify('Link copied. Anyone who can see this space can open it.')
    } catch {
      notify('Couldn’t copy the link. Copy it from the address bar instead.')
    }
  }

  const copy = async (as: 'markdown' | 'rich text') => {
    setAnchor(null)
    try {
      await (as === 'markdown' ? copyAsMarkdown : copyAsRichText)(getText())
      notify(`Copied as ${as}.`)
    } catch {
      notify(`Couldn’t copy as ${as}. Your browser blocked the clipboard.`)
    }
  }

  const shareTo = async (folder: string) => {
    await beforeShare()
    const { teamPath } = await api.shareToTeam(space, path, folder)
    tree.refreshPaths(space, [path])
    tree.refreshPaths('team', [teamPath])
    setPicking(false)
    notify('Shared to Team. Links to it keep working.')
    navigate(docUrl('team', teamPath), { replace: true })
  }

  return (
    <>
      <button
        type="button"
        data-testid="share-menu"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={iconOnly ? 'Share' : undefined}
        onClick={(event) => setAnchor(anchor ? null : below(event.currentTarget))}
        className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink"
      >
        <Icon name="share" />
        {iconOnly ? null : 'Share'}
      </button>
      {anchor ? (
        <Menu anchor={anchor} label="Share" onClose={() => setAnchor(null)}>
          <MenuItem icon="link" onSelect={() => void copyLink()}>
            Copy link
          </MenuItem>
          <MenuItem icon="copy" testId="copy-markdown" onSelect={() => void copy('markdown')}>
            Copy as markdown
          </MenuItem>
          <MenuItem icon="copy" testId="copy-rich-text" onSelect={() => void copy('rich text')}>
            Copy as rich text
          </MenuItem>
          {isPersonal ? (
            <MenuItem
              icon="share"
              testId="share-to-team"
              onSelect={() => {
                setAnchor(null)
                setPicking(true)
              }}
            >
              Share to team…
            </MenuItem>
          ) : null}
        </Menu>
      ) : null}
      {picking ? (
        <FolderPicker
          space="team"
          title="Share to team"
          confirmLabel="Share to this folder"
          initialFolder={DOCS_ROOT}
          onConfirm={shareTo}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </>
  )
}
