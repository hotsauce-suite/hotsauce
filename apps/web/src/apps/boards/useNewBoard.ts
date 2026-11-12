import { useState } from 'react'
import { useNavigate } from 'react-router'
import { boardsApi } from '../../api/boards'
import { boardUrl } from '../../lib/paths'

/** Makes a board (personal unless `team`) and opens it. */
export function useNewBoard() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async (team = false) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const board = await boardsApi.create(team ? { space: 'team' } : {})
      navigate(boardUrl(board.space, board.path), { state: { fresh: true } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t make the board')
    } finally {
      setBusy(false)
    }
  }
  return { create, busy, error }
}
