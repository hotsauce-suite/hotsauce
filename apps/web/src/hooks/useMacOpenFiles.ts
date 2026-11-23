import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../api/client'
import { uploadFile } from '../api/files'
import { installMacOpenFiles } from '../lib/macOpenFiles'
import { useSession } from '../state/session'

/** Lets the Mac app hand over files dropped on its icon (docs/PLAN-pdf-tools.md R10). */
export function useMacOpenFiles(): void {
  const session = useSession()
  const navigate = useNavigate()
  const go = useRef(navigate)
  go.current = navigate
  const personal = useRef<string | null>(null)
  personal.current = session.spaces.find((s) => s.kind === 'personal')?.name ?? null
  useEffect(
    () =>
      installMacOpenFiles(
        () => ({
          personalSpace: async () =>
            personal.current ??
            (await api.me()).spaces?.find((s) => s.kind === 'personal')?.name ??
            null,
          upload: (file, target) => uploadFile(file, target),
        }),
        (path) => go.current(path),
      ),
    [],
  )
}
