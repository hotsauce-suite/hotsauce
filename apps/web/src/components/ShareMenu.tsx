import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../api/client'
import { useOnline } from '../lib/connection'
import { copyAsMarkdown, copyAsRichText } from '../lib/copyNote'
import { DOCS_ROOT, docUrl } from '../lib/paths'
import { useSession } from '../state/session'
import { FolderPicker } from './FolderPicker'
import { MenuItem } from './Menu'
import { ReadOnlyLinkItems, useReadOnlyLink } from './ReadOnlyLink'
import { ShareButton } from './ShareButton'

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
  const online = useOnline()
  const navigate = useNavigate()
  const [picking, setPicking] = useState(false)
  const isPersonal = spaces.find((s) => s.name === space)?.kind === 'personal'
  const readOnly = useReadOnlyLink(space, path)

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify('Link copied. Anyone who can see this space can open it.')
    } catch {
      notify('Couldn’t copy the link. Copy it from the address bar instead.')
    }
  }

  const copy = async (as: 'markdown' | 'rich text') => {
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
      {readOnly.dialog}
      <ShareButton iconOnly={iconOnly} online={online} onOpen={() => readOnly.refresh()}>
        {(close) => (
          <>
            <MenuItem
              icon="link"
              onSelect={() => {
                close()
                void copyLink()
              }}
            >
              Copy link
            </MenuItem>
            <ReadOnlyLinkItems link={readOnly} close={close} before={beforeShare} />
            <MenuItem
              icon="copy"
              testId="copy-markdown"
              onSelect={() => {
                close()
                void copy('markdown')
              }}
            >
              Copy as markdown
            </MenuItem>
            <MenuItem
              icon="copy"
              testId="copy-rich-text"
              onSelect={() => {
                close()
                void copy('rich text')
              }}
            >
              Copy as rich text
            </MenuItem>
            {isPersonal ? (
              <MenuItem
                icon="share"
                testId="share-to-team"
                onSelect={() => {
                  close()
                  setPicking(true)
                }}
              >
                Share to team…
              </MenuItem>
            ) : null}
          </>
        )}
      </ShareButton>
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
