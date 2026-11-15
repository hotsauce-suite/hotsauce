// Which built files the service worker keeps on the device up front (docs/PLAN-offline.md, A1).
//
// Every screen of the app: the entry and each lazy route built from our own code, with
// everything they import and their CSS and fonts. Chunks that only a library loads on demand
// (CodeMirror language modes, diagram renderers, Whiteboard's locales) are left to be cached the
// first time they're used: there are hundreds, most people never need most of them.

/** The parts of a Rollup/Rolldown output chunk this reads. */
export interface BuiltChunk {
  type: 'chunk'
  fileName: string
  isEntry: boolean
  isDynamicEntry: boolean
  facadeModuleId: string | null
  imports: string[]
  viteMetadata?: { importedCss: Set<string>; importedAssets: Set<string> }
}

export interface BuiltAsset {
  type: 'asset'
  fileName: string
}

/** A lazy chunk is one of our screens when its entry module is our own source. */
export function isOwnScreen(chunk: BuiltChunk, sourceDir: string): boolean {
  const id = chunk.facadeModuleId
  return id !== null && id.startsWith(sourceDir) && !id.includes('/node_modules/')
}

/** File names to precache, out of everything the build wrote. */
export function screenFiles(
  bundle: Record<string, BuiltChunk | BuiltAsset>,
  sourceDir: string,
): Set<string> {
  const chunks = new Map<string, BuiltChunk>()
  for (const item of Object.values(bundle))
    if (item.type === 'chunk') chunks.set(item.fileName, item)
  const keep = new Set<string>()
  const visit = (name: string) => {
    if (keep.has(name)) return
    const chunk = chunks.get(name)
    if (!chunk) return
    keep.add(name)
    for (const css of chunk.viteMetadata?.importedCss ?? []) keep.add(css)
    for (const asset of chunk.viteMetadata?.importedAssets ?? []) keep.add(asset)
    for (const dep of chunk.imports) visit(dep)
  }
  for (const chunk of chunks.values()) {
    if (chunk.isEntry || (chunk.isDynamicEntry && isOwnScreen(chunk, sourceDir)))
      visit(chunk.fileName)
  }
  return keep
}
