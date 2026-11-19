import { useEffect, useRef } from 'react'
import { api } from '../api/client'
import { filesApi, uploadFile } from '../api/files'
import { sharesApi } from '../api/shares'
import { installMacScreenshots } from '../lib/macScreenshots'
import { useSession } from '../state/session'

/** Lets the Mac app share a screenshot through the signed-in page (docs/PLAN-screenshots.md R5). */
export function useMacScreenshots(): void {
  const session = useSession()
  const personal = useRef<string | null>(null)
  personal.current = session.spaces.find((s) => s.kind === 'personal')?.name ?? null
  useEffect(
    () =>
      installMacScreenshots(() => ({
        // Asked the moment the window loads, the session may not have its spaces yet.
        personalSpace: async () =>
          personal.current ??
          (await api.me()).spaces?.find((s) => s.kind === 'personal')?.name ??
          null,
        origin: window.location.origin,
        publicLinksAllowed: async () => (await sharesApi.sharing()).publicShareLinks,
        upload: (file, target) => uploadFile(file, target),
        share: (space, id, on, choice) => filesApi.share(space, id, on, choice),
      })),
    [],
  )
}
