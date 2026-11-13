// Sample whiteboards for the demo: Excalidraw elements written out in full, so the canvas opens
// them as it would a saved board.

import type { BoardElement, BoardScene } from '@hearth/format'

let seq = 0
const nextSeed = () => {
  seq += 1
  return 100_000 + seq * 7_919
}

/** Fields every element carries. */
function base(id: string, type: string, x: number, y: number, w: number, h: number) {
  return {
    id,
    type,
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [] as string[],
    frameId: null,
    roundness: null as { type: number } | null,
    seed: nextSeed(),
    version: 1,
    versionNonce: nextSeed(),
    isDeleted: false,
    boundElements: null as Array<{ id: string; type: string }> | null,
    updated: 1_760_000_000_000,
    link: null,
    locked: false,
  }
}

function box(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  bound: Array<{ id: string; type: string }> = [],
): BoardElement {
  return {
    ...base(id, 'rectangle', x, y, w, h),
    backgroundColor: fill,
    roundness: { type: 3 },
    boundElements: bound.length ? bound : null,
  }
}

function text(
  id: string,
  x: number,
  y: number,
  value: string,
  opts: { size?: number; containerId?: string; w?: number; align?: 'left' | 'center' } = {},
): BoardElement {
  const size = opts.size ?? 20
  const lines = value.split('\n')
  const width = opts.w ?? Math.max(...lines.map((l) => l.length)) * size * 0.55
  return {
    ...base(id, 'text', x, y, width, lines.length * size * 1.25),
    text: value,
    originalText: value,
    fontSize: size,
    fontFamily: 5,
    textAlign: opts.align ?? (opts.containerId ? 'center' : 'left'),
    verticalAlign: opts.containerId ? 'middle' : 'top',
    containerId: opts.containerId ?? null,
    autoResize: true,
    lineHeight: 1.25,
  }
}

/** A rectangle with its label inside, bound the way Excalidraw binds them. */
function labelled(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  label: string,
  arrows: string[] = [],
): BoardElement[] {
  const size = 20
  const lines = label.split('\n').length
  const th = lines * size * 1.25
  return [
    box(id, x, y, w, h, fill, [
      { id: `${id}-label`, type: 'text' },
      ...arrows.map((a) => ({ id: a, type: 'arrow' })),
    ]),
    text(`${id}-label`, x + 10, y + (h - th) / 2, label, { containerId: id, w: w - 20, size }),
  ]
}

function arrow(id: string, from: BoardElement, to: BoardElement): BoardElement {
  const sx = (from.x as number) + (from.width as number)
  const sy = (from.y as number) + (from.height as number) / 2
  const ex = to.x as number
  const ey = (to.y as number) + (to.height as number) / 2
  return {
    ...base(id, 'arrow', sx + 8, sy, ex - sx - 16, ey - sy),
    roundness: { type: 2 },
    points: [
      [0, 0],
      [ex - sx - 16, ey - sy],
    ],
    lastCommittedPoint: null,
    startBinding: { elementId: from.id, focus: 0, gap: 8 },
    endBinding: { elementId: to.id, focus: 0, gap: 8 },
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: false,
  }
}

export function launchPlanScene(): BoardScene {
  const prep = labelled('lp-prep', 80, 160, 220, 120, '#ffec99', 'Prep\nSAML, admin tour', [
    'lp-a1',
  ])
  const pilot = labelled(
    'lp-pilot',
    380,
    160,
    240,
    120,
    '#ffc9c9',
    'Pilot, 60 days\nNorth, Harbor, Valley',
    ['lp-a1', 'lp-a2'],
  )
  const rollout = labelled('lp-rollout', 680, 160, 220, 120, '#b2f2bb', 'Rollout\nPlan decision', [
    'lp-a2',
  ])
  const [prepBox] = prep as [BoardElement]
  const [pilotBox] = pilot as [BoardElement]
  const [rolloutBox] = rollout as [BoardElement]
  return {
    elements: [
      text('lp-title', 80, 60, 'Acme pilot launch plan', { size: 36 }),
      ...prep,
      ...pilot,
      ...rollout,
      arrow('lp-a1', prepBox, pilotBox),
      arrow('lp-a2', pilotBox, rolloutBox),
      text('lp-owner-1', 80, 300, 'Owner: Sam', { size: 16 }),
      text('lp-owner-2', 380, 300, 'Owner: Priya', { size: 16 }),
      text('lp-owner-3', 680, 300, 'Owner: Ada', { size: 16 }),
      ...labelled('lp-note', 380, 380, 260, 110, '#a5d8ff', 'Goal: 40 active\npeople by week 8'),
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }
}

export function retroScene(): BoardScene {
  const columns: Array<[string, string, number, string[]]> = [
    ['rt-good', 'Went well', 80, ['SAML set up\nin a day', 'Meeting notes\nbecome tasks']],
    ['rt-meh', 'Could be better', 380, ['Valley site waiting\non laptops', 'Importing old docs']],
    ['rt-try', 'Try next', 680, ['Office hours\ntwice a week', 'Share the\nsign-up chart']],
  ]
  const fills = ['#b2f2bb', '#ffec99', '#a5d8ff']
  const elements: BoardElement[] = [
    text('rt-title', 80, 40, 'Onboarding retro, week 2', { size: 32 }),
  ]
  columns.forEach(([id, heading, x, notes], i) => {
    elements.push(text(`${id}-head`, x, 110, heading, { size: 24 }))
    notes.forEach((note, n) => {
      elements.push(...labelled(`${id}-${n}`, x, 160 + n * 130, 240, 100, fills[i] as string, note))
    })
  })
  return { elements, appState: { viewBackgroundColor: '#ffffff' }, files: {} }
}

export function agendaScene(): BoardScene {
  return {
    elements: [
      text('ag-title', 80, 40, 'Pilot review agenda', { size: 32 }),
      ...labelled('ag-1', 80, 110, 280, 80, '#ffec99', '1. Sign-ups vs goal'),
      ...labelled('ag-2', 80, 210, 280, 80, '#ffc9c9', '2. Valley site blockers'),
      ...labelled('ag-3', 80, 310, 280, 80, '#b2f2bb', '3. Annual plan: yes or no'),
      text('ag-note', 400, 130, 'Bring the sign-up chart\nfrom Files', { size: 18 }),
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  }
}
