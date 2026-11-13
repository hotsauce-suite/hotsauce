// The app-wide shortcuts AppShell owns: `g` then a letter, and the defaults for `c` and `/`
// that a page replaces with its own (Tasks' quick add, Docs' New doc).

import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { APPS, type AppId } from '../apps/registry'
import { appHref } from '../components/AppRail'
import { GO_KEYS, type GoTarget } from './catalog'
import { bindShortcut, useShortcut } from './shortcuts'

/** The field `c` puts the cursor in, on pages that create from a title box. */
const CREATE_FIELDS: Partial<Record<AppId, string>> = {
  forms: 'input[aria-label="New form\'s title"]',
  tables: 'input[aria-label="New table\'s name"]',
}

/** Where `c` goes in an app whose page doesn't bind it: the app's own "new" page. */
const CREATE_ROUTES: Partial<Record<AppId, string>> = {
  meetings: '/meetings/start',
  clips: '/clips/new',
  dictate: '/dictate/voice',
}

export function useAppShortcuts({ app, openSearch }: { app: AppId; openSearch: () => void }): void {
  const navigate = useNavigate()

  useEffect(() => {
    const offs = (Object.keys(GO_KEYS) as GoTarget[]).map((target) =>
      bindShortcut(
        `go.${target}`,
        () => {
          if (target === 'settings') {
            navigate('/settings')
            return true
          }
          const manifest = APPS.find((a) => a.id === target)
          if (!manifest) return false
          navigate(appHref(manifest))
          return true
        },
        { fallback: true },
      ),
    )
    return () => {
      for (const off of offs) off()
    }
  }, [navigate])

  useShortcut(
    'global.create',
    () => {
      const field = CREATE_FIELDS[app]
      const input = field ? document.querySelector<HTMLInputElement>(field) : null
      if (input) {
        input.focus()
        return true
      }
      const to = CREATE_ROUTES[app]
      if (!to) return false
      navigate(to)
      return true
    },
    true,
    { fallback: true },
  )

  useShortcut(
    'global.search',
    () => {
      openSearch()
      return true
    },
    true,
    { fallback: true },
  )
}
