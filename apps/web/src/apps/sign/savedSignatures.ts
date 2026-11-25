// The member's saved signature and initials, loaded once per screen
// (docs/PLAN-sign-saved-signature.md R5–R7).

import { useCallback, useEffect, useState } from 'react'
import { type MarkKind, type SavedSignatures, savedSignatureApi } from '../../api/sign'
import type { Signature } from './SignaturePad'

const NONE: SavedSignatures = { signature: null, initials: null }

export function useSavedSignatures(enabled = true) {
  const [saved, setSaved] = useState<SavedSignatures | null>(enabled ? null : NONE)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    savedSignatureApi.get().then(
      (s) => {
        if (!cancelled) setSaved(s)
      },
      () => {
        // Signing still works without them: the dialog just has no Saved tab.
        if (!cancelled) {
          setSaved(NONE)
          setFailed(true)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled])

  /** Keeps a signature for next time; resolves false when it couldn't be saved. */
  const keep = useCallback(async (kind: MarkKind, s: Signature): Promise<boolean> => {
    try {
      setSaved(
        await savedSignatureApi.save(
          kind,
          'image' in s ? { input: s.input, image: s.image } : { input: 'typed', value: s.value },
        ),
      )
      return true
    } catch {
      return false
    }
  }, [])

  const forget = useCallback(async (kind: MarkKind): Promise<boolean> => {
    try {
      setSaved(await savedSignatureApi.remove(kind))
      return true
    } catch {
      return false
    }
  }, [])

  return { saved, failed, keep, forget }
}
