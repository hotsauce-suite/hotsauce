import path from 'node:path'

export {
  type FileRow,
  Index,
  type IndexFile,
  type ListFilesOptions,
  NEVER_CHANGED,
  type SearchHit,
  type SearchOptions,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  type SpaceRecord,
} from './db.js'
export { extractDoc, type FileKind, isIndexable, kindOf } from './extract.js'
export { type Entry, type GitReader, Indexer } from './indexer.js'
export { toFtsAnyQuery, toFtsQuery } from './query.js'

/** Where the server and `hearth reindex` keep the index. */
export function indexPath(dataDir: string): string {
  return path.join(dataDir, 'index.sqlite')
}
