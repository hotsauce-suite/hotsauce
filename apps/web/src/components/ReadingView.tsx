import { parseFrontmatter, resolveRelative } from '@hearth/format'
import { type MouseEvent, useEffect, useMemo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { useNavigate } from 'react-router'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { docUrl, isExternalHref, isMarkdown } from '../lib/paths'
import { remarkCallouts } from '../lib/remarkCallouts'
import { TaskQueryList } from './TaskQueryList'

/** Turns an image src from the document into a loadable URL (see `ImageUrls`). */
export type ResolveImage = (src: string) => Promise<string>

function RepoImage({
  src,
  alt,
  resolveImage,
}: {
  src: string
  alt: string
  resolveImage: ResolveImage
}) {
  const [url, setUrl] = useState<string | null>(isExternalHref(src) ? src : null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let live = true
    resolveImage(src).then(
      (resolved) => live && setUrl(resolved),
      () => live && setMissing(true),
    )
    return () => {
      live = false
    }
  }, [resolveImage, src])
  if (missing) return <span className="text-sm text-ink-faint italic">Image not found: {src}</span>
  return url ? <img src={url} alt={alt} /> : <span className="block h-40" aria-hidden="true" />
}

/** The whole document rendered, read-only. Relative links to docs open in the app. */
export default function ReadingView({
  markdown,
  space,
  path,
  resolveImage,
  embedded = false,
  personalSpace = null,
}: {
  markdown: string
  space: string
  path: string
  resolveImage: ResolveImage
  /** Inside another view (history preview): no test ID, so the main reading view stays unique. */
  embedded?: boolean
  /** What a `tasks` block's `space: personal` means. */
  personalSpace?: string | null
}) {
  const navigate = useNavigate()
  const body = useMemo(() => parseFrontmatter(markdown).body, [markdown])

  const components = useMemo<Components>(
    () => ({
      a: ({ href = '', children }) => {
        if (isExternalHref(href) || href.startsWith('#')) {
          const external = isExternalHref(href)
          return (
            <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
              {children}
            </a>
          )
        }
        const target = resolveRelative(path, href)
        if (!isMarkdown(target)) return <a href={href}>{children}</a>
        const url = docUrl(space, target)
        const open = (event: MouseEvent) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return
          event.preventDefault()
          navigate(url)
        }
        return (
          <a href={url} onClick={open}>
            {children}
          </a>
        )
      },
      // A `tasks` block reads as its live task list.
      pre: ({ children, node }) => {
        const code = node?.children[0]
        const classes = code?.type === 'element' ? code.properties.className : undefined
        if (Array.isArray(classes) && classes.includes('language-tasks')) {
          const text = code?.type === 'element' ? textOf(code) : ''
          return (
            <TaskQueryList
              source={text.replace(/\n$/, '')}
              personalSpace={personalSpace}
              onOpen={navigate}
            />
          )
        }
        return <pre>{children}</pre>
      },
      img: ({ src, alt }) =>
        typeof src === 'string' ? (
          <RepoImage src={src} alt={alt ?? ''} resolveImage={resolveImage} />
        ) : null,
    }),
    [navigate, space, path, resolveImage, personalSpace],
  )

  return (
    <article data-testid={embedded ? undefined : 'reading-view'} className="prose-hearth">
      <Markdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {body}
      </Markdown>
    </article>
  )
}

/** The plain text of a hast element (a code block's source, before highlighting is applied). */
function textOf(node: { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map((c) => textOf(c as Parameters<typeof textOf>[0])).join('')
}
