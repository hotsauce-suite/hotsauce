import { describe, expect, it } from 'vitest'
import { type BuiltAsset, type BuiltChunk, screenFiles } from './precache'

const SRC = '/repo/apps/web/src'

function chunk(fileName: string, extra: Partial<BuiltChunk> = {}): BuiltChunk {
  return {
    type: 'chunk',
    fileName,
    isEntry: false,
    isDynamicEntry: false,
    facadeModuleId: null,
    imports: [],
    ...extra,
  }
}

describe('the precache list (A1.1)', () => {
  it('keeps every screen of ours and what it imports, and leaves on-demand library chunks', () => {
    const bundle: Record<string, BuiltChunk | BuiltAsset> = {
      entry: chunk('assets/index-a.js', {
        isEntry: true,
        facadeModuleId: `${SRC}/main.tsx`,
        imports: ['assets/react-b.js'],
        viteMetadata: { importedCss: new Set(['assets/index-a.css']), importedAssets: new Set() },
      }),
      react: chunk('assets/react-b.js'),
      tasks: chunk('assets/TasksPage-c.js', {
        isDynamicEntry: true,
        facadeModuleId: `${SRC}/apps/tasks/TasksPage.tsx`,
        imports: ['assets/shared-d.js'],
      }),
      shared: chunk('assets/shared-d.js', { imports: ['assets/react-b.js'] }),
      // A CodeMirror language mode, imported on demand by the editor library.
      mode: chunk('assets/apl-e.js', {
        isDynamicEntry: true,
        facadeModuleId: '/repo/node_modules/@codemirror/legacy-modes/mode/apl.js',
      }),
      diagram: chunk('assets/sequenceDiagram-f.js', {
        isDynamicEntry: true,
        facadeModuleId: '/repo/node_modules/mermaid/dist/sequenceDiagram.js',
        imports: ['assets/mermaid-core-g.js'],
      }),
      mermaid: chunk('assets/mermaid-core-g.js'),
      font: { type: 'asset', fileName: 'assets/font-h.woff2' },
    }
    expect([...screenFiles(bundle, SRC)].sort()).toEqual([
      'assets/TasksPage-c.js',
      'assets/index-a.css',
      'assets/index-a.js',
      'assets/react-b.js',
      'assets/shared-d.js',
    ])
  })
})
