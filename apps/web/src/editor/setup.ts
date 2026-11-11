import { autocompletion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { search, searchKeymap } from '@codemirror/search'
import { Annotation, type Extension, type Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { insertLink, toggleMarker } from './commands'
import { imageUpload } from './imagePaste'
import { type LivePreviewOptions, livePreview } from './livePreview'
import { type LinkTarget, wikiLinkSource } from './wikiLink'

/** Marks transactions that adopt text from the server, so they don't count as user edits. */
export const remoteChange = Annotation.define<boolean>()

// Colors come from tokens.css so code follows the light/dark theme.
const hearthHighlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword],
    color: 'var(--code-keyword)',
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--code-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--code-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--code-property)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--ink-faint)' },
  { tag: t.quote, color: 'var(--ink-soft)' },
  { tag: t.url, color: 'var(--ink-faint)' },
])

export interface EditorServices extends LivePreviewOptions {
  onChange: (text: Text) => void
  upload: (file: File) => Promise<string>
  findTargets: (query: string) => Promise<LinkTarget[]>
  currentPath: () => string
  onError: (message: string) => void
}

export function editorExtensions(services: EditorServices): Extension[] {
  return [
    history(),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(hearthHighlight),
    search({ top: true }),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      'data-testid': 'editor-content',
      'aria-label': 'Document text',
      autocapitalize: 'sentences',
      spellcheck: 'true',
    }),
    keymap.of([
      { key: 'Mod-b', run: toggleMarker('**') },
      { key: 'Mod-i', run: toggleMarker('*') },
      { key: 'Mod-k', run: insertLink },
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    autocompletion({
      override: [wikiLinkSource(services.findTargets, services.currentPath)],
      icons: false,
    }),
    livePreview(services),
    imageUpload({ upload: services.upload, onError: services.onError }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      if (update.transactions.every((tr) => tr.annotation(remoteChange))) return
      services.onChange(update.state.doc)
    }),
  ]
}
