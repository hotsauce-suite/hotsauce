import { useParams } from 'react-router'
import { DocumentView } from '../components/DocumentView'

function decode(splat: string): string {
  try {
    return decodeURIComponent(splat)
  } catch {
    return splat
  }
}

/** /docs/:space/* — one document. Keyed so each file gets a fresh document state. */
export default function DocRoute() {
  const params = useParams()
  const space = params.space ?? ''
  const path = decode(params['*'] ?? '')
  return <DocumentView key={`${space}:${path}`} space={space} path={path} />
}
