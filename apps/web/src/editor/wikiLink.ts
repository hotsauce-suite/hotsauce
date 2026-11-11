import type { Completion, CompletionContext, CompletionSource } from '@codemirror/autocomplete'
import { relativeLink } from '@hearth/format'

export interface LinkTarget {
  path: string
  title: string
}

/**
 * `[[` autocomplete. `[[` is only the typing shortcut: the file gets a standard relative
 * markdown link, so docs stay portable to Obsidian, GitHub and plain editors.
 */
export function wikiLinkSource(
  findTargets: (query: string) => Promise<LinkTarget[]>,
  currentPath: () => string,
): CompletionSource {
  return async (context: CompletionContext) => {
    const match = context.matchBefore(/\[\[[^\]\n]*$/)
    if (!match) return null
    const query = match.text.slice(2)
    const targets = await findTargets(query)
    if (context.aborted) return null
    const from = match.from + 2
    const options: Completion[] = targets
      .filter((target) => target.path !== currentPath())
      .map((target) => ({
        label: target.title,
        detail: target.path.replace(/^docs\//, ''),
        type: 'text',
        apply: (view, _completion, applyFrom, applyTo) => {
          const start = applyFrom - 2
          // Swallow a `]]` the user may already have typed after the cursor.
          const end = view.state.sliceDoc(applyTo, applyTo + 2) === ']]' ? applyTo + 2 : applyTo
          const insert = `[${target.title}](${relativeLink(currentPath(), target.path)})`
          view.dispatch({
            changes: { from: start, to: end, insert },
            selection: { anchor: start + insert.length },
            userEvent: 'input.complete',
          })
        },
      }))
    return { from, options, filter: false }
  }
}
