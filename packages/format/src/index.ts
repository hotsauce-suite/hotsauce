export const FORMAT_VERSION = 1

export { assetPath } from './assets.js'
export { type Chunk, chunkMarkdown } from './chunks.js'
export {
  ensureId,
  FrontmatterError,
  type Parsed,
  parseFrontmatter,
  patchFrontmatter,
} from './frontmatter.js'
export { isId, newId } from './ids.js'
export { extractLinks, type Link, rewriteLinksForMove } from './links.js'
export {
  formatTranscriptLine,
  meetingPaths,
  parseTranscript,
  type TranscriptLine,
  transcriptPathFor,
} from './meetings.js'
export {
  docPath,
  extractTitle,
  newDoc,
  relativeLink,
  resolveRelative,
  slugify,
} from './paths.js'
export { DocFrontmatter, MeetingFrontmatter, SpaceConfig } from './schemas.js'
export {
  initialSpaceFiles,
  parseSpaceConfig,
  SPACE_LAYOUT,
  serializeSpaceConfig,
} from './space.js'
