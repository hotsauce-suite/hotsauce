import { useNavigate } from 'react-router'
import { useShell } from '../components/AppShell'
import { Icon } from '../components/Icon'
import { MainButton, PageHeader } from '../components/PageHeader'
import { DOCS_ROOT, docUrl } from '../lib/paths'
import { useSession } from '../state/session'
import { untitledDocPath } from '../state/treeStore'

/** /docs with nothing open. */
export default function DocsIndex() {
  const { openSearch } = useShell()
  const session = useSession()
  const navigate = useNavigate()
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

  const startDoc = async () => {
    const path = await untitledDocPath(session.tree, session.space, DOCS_ROOT)
    navigate(docUrl(session.space, path), { state: { newDoc: true } })
  }

  return (
    <>
      <PageHeader title="Docs">
        <MainButton icon="plus" testId="docs-new" onClick={() => void startDoc()}>
          New doc
        </MainButton>
      </PageHeader>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="max-w-md">
          <h2 className="font-display text-[2.4rem] leading-[1.1] font-semibold tracking-tight text-ink [font-variation-settings:'opsz'_120]">
            Pick up where the team left off.
          </h2>
          <p className="mt-3 text-ink-soft">
            Open a doc from {session.spaceLabel(session.space)}, search everything, or press New
            doc. Every doc is a markdown file in Git.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
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
