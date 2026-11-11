import { type ReactNode, useEffect, useState } from 'react'
import { meetingsApi } from '../../../api/meetings'
import type { MeetingTemplate } from '../../../api/types'
import { useShell } from '../../../components/AppShell'
import { IconButton } from '../../../components/TopBar'

/** The top bar of a Meetings page that isn't a document. */
export function MeetingsPageHeader({
  title,
  children,
}: {
  title: ReactNode
  children?: ReactNode
}) {
  const { compact, openDrawer } = useShell()
  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-2 border-b border-ash/70 bg-paper/80 px-2 backdrop-blur-sm md:px-4">
      {compact ? <IconButton icon="menu" label="Open sidebar" onClick={openDrawer} /> : null}
      <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold tracking-tight text-ink">
        {title}
      </h1>
      {children}
    </header>
  )
}

/** Built-in templates plus the team's and the member's own (`GET /api/meetings/templates`). */
export function useTemplates(): MeetingTemplate[] {
  const [templates, setTemplates] = useState<MeetingTemplate[]>([])
  useEffect(() => {
    let cancelled = false
    meetingsApi.templates().then(
      (list) => {
        if (!cancelled) setTemplates(list)
      },
      () => {
        // The select keeps showing the current template; enhancing still works.
      },
    )
    return () => {
      cancelled = true
    }
  }, [])
  return templates
}

const SOURCE_LABEL: Record<MeetingTemplate['source'], string> = {
  builtin: '',
  team: ' · Team',
  personal: ' · Yours',
}

export function TemplateSelect({
  templates,
  value,
  onChange,
  testId,
  disabled,
  className = '',
}: {
  templates: MeetingTemplate[]
  value: string
  onChange: (id: string) => void
  testId: string
  disabled?: boolean
  className?: string
}) {
  // Until the list loads, the current template is still shown (and selectable).
  const options = templates.some((t) => t.id === value)
    ? templates
    : [{ id: value, name: value, description: '', source: 'builtin' as const }, ...templates]
  return (
    <select
      data-testid={testId}
      aria-label="Template"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={`h-9 rounded-lg border border-ash bg-paper-raised px-2.5 text-sm text-ink hover:border-ash-strong disabled:opacity-60 ${className}`}
    >
      {options.map((t) => (
        <option key={t.id} value={t.id} title={t.description}>
          {t.name}
          {SOURCE_LABEL[t.source]}
        </option>
      ))}
    </select>
  )
}

export const primaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-ember px-4 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:cursor-not-allowed disabled:opacity-50'

export const secondaryButton =
  'inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-ash-strong px-4 text-sm text-ink hover:border-ember disabled:cursor-not-allowed disabled:opacity-50'
