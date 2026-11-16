export { fakePageFetcher, fakePaperPdf } from './fake.js'
export {
  type FetchKind,
  fetchPage,
  isPublicAddress,
  LinkFetchError,
  liveFetcher,
  type PageFetcher,
} from './fetch.js'
export { readPage } from './read.js'
export { MAX_ANCHOR, type ReadingPlace, ReadingStore } from './reading.js'
export {
  type HighlightInput,
  type HighlightView,
  type LinkFilter,
  type LinkListView,
  type LinkPatch,
  type LinkStatus,
  Links,
  type LinksDeps,
  type LinkView,
  type LinkWithBody,
  linkName,
  MAX_HIGHLIGHT_LIST,
  MAX_LINK_LIST,
  type NamedHighlight,
  parseTagAnswer,
  type SaveInput,
} from './service.js'
