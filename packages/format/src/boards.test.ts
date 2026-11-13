import { describe, expect, it } from 'vitest'
import {
  type BoardElement,
  BoardFormatError,
  BoardFrontmatter,
  type BoardScene,
  BoardScene as BoardSceneSchema,
  boardIdOf,
  boardPath,
  boardSearchText,
  boardTexts,
  compactTombstone,
  EMPTY_SCENE,
  mergeScenes,
  newBoardFile,
  parseBoardBody,
  pruneFiles,
  tidyScene,
} from './boards.js'
import { parseFrontmatter } from './frontmatter.js'

const ID = '01JD0000000000000000000000'

function el(id: string, version: number, extra: Partial<BoardElement> = {}): BoardElement {
  return { id, type: 'rectangle', version, versionNonce: 1, x: 0, y: 0, ...extra }
}

function scene(elements: BoardElement[], files: BoardScene['files'] = {}): BoardScene {
  return { elements, appState: {}, files }
}

function bodyOf(text: string): string {
  return parseFrontmatter(text).body
}

describe('board paths', () => {
  it('maps ids to boards/<id>.md and back', () => {
    expect(boardPath(ID)).toBe(`boards/${ID}.md`)
    expect(boardIdOf(`boards/${ID}.md`)).toBe(ID)
    expect(boardIdOf(`boards/nested/${ID}.md`)).toBeNull()
    expect(boardIdOf('boards/hello.md')).toBeNull()
    expect(boardIdOf(`notes/${ID}.md`)).toBeNull()
  })
})

describe('newBoardFile', () => {
  it('writes frontmatter, a text list and the scene block, and round-trips', () => {
    const s = scene([
      el('a', 1, { type: 'text', text: 'Hello\nworld' }),
      el('b', 2),
      el('c', 3, { type: 'text', text: 'gone', isDeleted: true }),
      el('d', 1, { type: 'text', text: '# not a heading' }),
    ])
    const file = newBoardFile({
      id: ID,
      title: '  Q4   plan ',
      scene: s,
      createdBy: 'Sam@Example.test',
      created: '2026-11-12T05:00:00Z',
    })
    expect(file.path).toBe(`boards/${ID}.md`)
    const fm = BoardFrontmatter.parse(parseFrontmatter(file.text).data)
    expect(fm).toMatchObject({
      id: ID,
      type: 'board',
      title: 'Q4 plan',
      created_by: 'sam@example.test',
      created: '2026-11-12T05:00:00Z',
      updated: '2026-11-12T05:00:00Z',
    })
    const body = bodyOf(file.text)
    expect(body).toContain('- Hello world\n')
    expect(body).toContain('- \\# not a heading\n')
    expect(body).not.toContain('- gone')
    expect(parseBoardBody(body)).toEqual(s)
  })

  it('puts one element per line in the scene block', () => {
    const file = newBoardFile({
      id: ID,
      scene: scene([el('a', 1), el('b', 1)]),
      createdBy: 'x@example.test',
    })
    const lines = bodyOf(file.text).split('\n')
    expect(lines.filter((l) => l.startsWith('{"id":"')).length).toBe(2)
  })

  it('an empty board round-trips', () => {
    const file = newBoardFile({ id: ID, createdBy: 'x@example.test' })
    expect(parseBoardBody(bodyOf(file.text))).toEqual(EMPTY_SCENE)
  })

  it('survives text that contains backtick fences', () => {
    const s = scene([el('a', 1, { type: 'text', text: 'see ```` here' })])
    const file = newBoardFile({ id: ID, scene: s, createdBy: 'x@example.test' })
    expect(parseBoardBody(bodyOf(file.text))).toEqual(s)
  })
})

describe('parseBoardBody', () => {
  it('a body without a scene is an empty board', () => {
    expect(parseBoardBody('\nJust words\n')).toEqual(EMPTY_SCENE)
  })

  it('refuses broken JSON or a bad scene', () => {
    expect(() => parseBoardBody('```excalidraw\n{nope\n```\n')).toThrow(BoardFormatError)
    expect(() => parseBoardBody('```excalidraw\n{"elements":[{"id":1}]}\n```\n')).toThrow(
      BoardFormatError,
    )
  })

  it('keeps fields Hearth does not know', () => {
    const s = parseBoardBody(
      '```excalidraw\n{"elements":[{"id":"a","type":"arrow","version":3,"points":[[0,0],[5,5]]}],"appState":{"viewBackgroundColor":"#fff","zoom":2},"files":{}}\n```\n',
    )
    expect(s.elements[0]).toMatchObject({
      points: [
        [0, 0],
        [5, 5],
      ],
    })
    expect(s.appState).toMatchObject({ zoom: 2 })
  })
})

describe('boardTexts and boardSearchText', () => {
  it('lists live text only', () => {
    expect(
      boardTexts(
        scene([
          el('a', 1, { type: 'text', text: ' a  b ' }),
          el('b', 1, { type: 'text', text: '  ' }),
        ]),
      ),
    ).toEqual(['a b'])
  })

  it('search text keeps the list and drops the scene and the marker comment', () => {
    const file = newBoardFile({
      id: ID,
      scene: scene([
        el('a', 1, { type: 'text', text: 'Roadmap' }),
        el('b', 1, { strokeColor: 'zebra' }),
      ]),
      createdBy: 'x@example.test',
    })
    const text = boardSearchText(bodyOf(file.text))
    expect(text).toContain('Roadmap')
    expect(text).not.toContain('zebra')
    expect(text).not.toContain('Hotsauce Whiteboard')
  })

  it('search text also drops the marker comment older boards were written with', () => {
    const body =
      '<!-- A Hearth Whiteboard. Open it in Hearth to draw; the list is the text on the board. -->\n- Roadmap\n'
    const text = boardSearchText(body)
    expect(text).toContain('Roadmap')
    expect(text).not.toContain('Whiteboard')
  })
})

describe('mergeScenes', () => {
  it('keeps elements from both sides and the higher version of a shared one', () => {
    const saved = scene([el('a', 2, { x: 10 }), el('b', 1)])
    const mine = scene([el('a', 1), el('c', 1)])
    const merged = mergeScenes(saved, mine)
    expect(merged.elements.map((e) => e.id)).toEqual(['a', 'c', 'b'])
    expect(merged.elements[0]).toMatchObject({ x: 10, version: 2 })
  })

  it('a delete with a higher version wins', () => {
    const merged = mergeScenes(scene([el('a', 1)]), scene([el('a', 2, { isDeleted: true })]))
    expect(merged.elements[0]?.isDeleted).toBe(true)
  })

  it('a tie goes to the lower versionNonce', () => {
    const merged = mergeScenes(
      scene([el('a', 3, { versionNonce: 9, x: 1 })]),
      scene([el('a', 3, { versionNonce: 4, x: 2 })]),
    )
    expect(merged.elements[0]).toMatchObject({ x: 2 })
  })

  it('places a run of new elements after the one they followed, in order', () => {
    const saved = scene([el('a', 1), el('b', 1)])
    const mine = scene([el('x', 1), el('a', 1), el('n1', 1), el('n2', 1), el('b', 1), el('z', 1)])
    expect(mergeScenes(saved, mine).elements.map((e) => e.id)).toEqual([
      'a',
      'n1',
      'n2',
      'b',
      'z',
      'x',
    ])
  })

  it('merges big scenes quickly', () => {
    const saved = scene(Array.from({ length: 15_000 }, (_, i) => el(`s${i}`, 1)))
    const mine = scene([
      ...saved.elements,
      ...Array.from({ length: 5_000 }, (_, i) => el(`m${i}`, 1)),
    ])
    const t = performance.now()
    expect(mergeScenes(saved, mine).elements).toHaveLength(20_000)
    expect(performance.now() - t).toBeLessThan(500)
  })

  it('keeps the saved canvas settings and applies the ones ours changed', () => {
    const merged = mergeScenes(
      { elements: [], appState: { viewBackgroundColor: '#ffc9c9', gridSize: 20 }, files: {} },
      { elements: [], appState: { gridModeEnabled: true }, files: {} },
    )
    expect(merged.appState).toEqual({
      viewBackgroundColor: '#ffc9c9',
      gridSize: 20,
      gridModeEnabled: true,
    })
  })

  it('unions files', () => {
    const merged = mergeScenes(
      scene([], { f1: { mimeType: 'image/png', path: 'assets/a.png' } }),
      scene([], { f2: { mimeType: 'image/png', path: 'assets/b.png' } }),
    )
    expect(Object.keys(merged.files).sort()).toEqual(['f1', 'f2'])
  })
})

describe('pruneFiles', () => {
  it('drops files no live element uses', () => {
    const s = scene(
      [
        el('i', 1, { type: 'image', fileId: 'f1' }),
        el('j', 2, { type: 'image', fileId: 'f2', isDeleted: true }),
      ],
      {
        f1: { mimeType: 'image/png', path: 'assets/a.png' },
        f2: { mimeType: 'image/png', path: 'assets/b.png' },
      },
    )
    expect(Object.keys(pruneFiles(s).files)).toEqual(['f1'])
  })
})

describe('tidyScene and limits', () => {
  it('shrinks deleted elements to what merging needs', () => {
    const big = el('d', 4, {
      type: 'freedraw',
      isDeleted: true,
      index: 'a1',
      points: Array.from({ length: 500 }, (_, i) => [i, i]),
    } as Partial<BoardElement>)
    expect(compactTombstone(big)).toEqual({
      id: 'd',
      type: 'freedraw',
      version: 4,
      versionNonce: 1,
      isDeleted: true,
      index: 'a1',
    })
    const live = el('l', 1)
    expect(tidyScene(scene([big, live])).elements[1]).toBe(live)
  })

  it('refuses iframe elements, whose HTML Excalidraw would run', () => {
    const bad = { elements: [el('f', 1, { type: 'iframe' })], appState: {}, files: {} }
    expect(BoardSceneSchema.safeParse(bad).success).toBe(false)
    expect(BoardSceneSchema.safeParse(scene([el('r', 1)])).success).toBe(true)
  })

  it('caps live shapes, not tombstones', () => {
    const dead = Array.from({ length: 20_001 }, (_, i) => el(`d${i}`, 2, { isDeleted: true }))
    expect(BoardSceneSchema.safeParse(scene(dead)).success).toBe(true)
    const live = Array.from({ length: 20_001 }, (_, i) => el(`l${i}`, 1))
    expect(BoardSceneSchema.safeParse(scene(live)).success).toBe(false)
  })
})
