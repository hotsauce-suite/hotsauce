import { useNavigate } from 'react-router'
import { product } from '../brand/product'
import { useShell } from '../components/AppShell'
import { Icon } from '../components/Icon'
import { IconButton } from '../components/TopBar'
import { DOCS_ROOT, docUrl } from '../lib/paths'
import { useSession } from '../state/session'
import { untitledDocPath } from '../state/treeStore'

/** /docs with nothing open. */
export default function DocsIndex() {
  const { compact, openDrawer, openSearch } = useShell()
  const session = useSession()
  const navigate = useNavigate()
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  const startDoc = async () => {
    const path = await untitledDocPath(session.tree, session.space, DOCS_ROOT)
    navigate(docUrl(session.space, path), { state: { newDoc: true } })
  }

  return (
    <>
      {compact ? (
        <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-2 border-b border-ash/70 px-2">
          <IconButton icon="menu" label="Open sidebar" onClick={openDrawer} />
          <span className="font-display text-lg font-semibold">{product()} Docs</span>
        </header>
      ) : null}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md">
          <h1 className="font-display text-[2.4rem] leading-[1.1] font-semibold tracking-tight text-ink [font-variation-settings:'opsz'_120]">
            Pick up where the team left off.
          </h1>
          <p className="mt-3 text-ink-soft">
            Open a doc from {session.spaceLabel(session.space)}, search everything, or start
            something new. Every doc is a markdown file in Git.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void startDoc()}
              className="flex items-center gap-2 rounded-lg bg-ember px-4 py-2.5 text-sm font-medium text-paper-raised hover:bg-ember-strong"
            >
              <Icon name="plus" />
              Start a doc
            </button>
            <button
              type="button"
              onClick={openSearch}
              className="flex items-center gap-2 rounded-lg border border-ash-strong px-4 py-2.5 text-sm text-ink hover:border-ember"
            >
              <Icon name="search" />
              Search
              <kbd className="font-mono text-xs text-ink-faint">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
