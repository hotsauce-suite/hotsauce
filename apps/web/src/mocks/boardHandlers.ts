// MSW routes for Hearth Whiteboard (`/api/boards`, ARCHITECTURE §15.3), in memory and shaped like
// the server's (apps/server/src/boards). Saves merge element by element with the format's own
// mergeScenes, as the server does. The live-drawing socket is a room with only you in it.

import {
  BoardScene,
  boardPath,
  boardTexts,
  boardTitle,
  EMPTY_SCENE,
  liveElements,
  mergeScenes,
  newId,
  SPACE_LAYOUT,
  tidyScene,
} from '@hearth/format'
import { type AnyHandler, delay, HttpResponse, http, ws } from 'msw'
import type { BoardSummary, BoardView } from '../api/boards'
import { agendaScene, launchPlanScene, retroScene } from './boardSeed'
import type { FakeUser } from './fakeRepo'
import { PRIYA, SAM, seedId } from './seed'

const DAY = 86_400_000
const BOARD_ID = /^[0-9A-Z]{26}$/

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// One link per page: every ws.link() adds a listener to MSW's shared BroadcastChannel.
const boardSocket = ws.link(
  new URL('/ws/boards/:space/:id', window.location.origin).href.replace(/^http/, 'ws'),
)

interface FakeBoard {
  space: string
  id: string
  title: string
  created: string
  createdBy: string
  updated: string
  updatedBy: string | null
  blobOid: string
  scene: BoardScene
}

export class FakeBoards {
  readonly boards = new Map<string, FakeBoard>()
  /** Members whose personal sample board is in place. */
  readonly seeded = new Set<string>()

  key(space: string, id: string): string {
    return `${space}/${id}`
  }

  get(space: string, id: string): FakeBoard | undefined {
    return this.boards.get(this.key(space, id))
  }

  add(input: {
    space: string
    title?: string | undefined
    scene?: BoardScene | undefined
    by: string
    at?: number
    updatedBy?: string
    id?: string
  }): FakeBoard {
    const at = iso(input.at ?? Date.now())
    const board: FakeBoard = {
      space: input.space,
      id: input.id ?? newId(),
      title: boardTitle(input.title ?? ''),
      created: at,
      createdBy: input.by.toLowerCase(),
      updated: at,
      updatedBy: input.updatedBy?.toLowerCase() ?? null,
      blobOid: newId().toLowerCase(),
      scene: tidyScene(input.scene ?? EMPTY_SCENE),
    }
    this.boards.set(this.key(board.space, board.id), board)
    return board
  }

  summary(b: FakeBoard): BoardSummary {
    return {
      space: b.space,
      path: boardPath(b.id),
      id: b.id,
      blobOid: b.blobOid,
      title: b.title,
      created: b.created,
      createdBy: b.createdBy,
      updated: b.updated,
      updatedBy: b.updatedBy,
    }
  }

  view(b: FakeBoard): BoardView {
    return {
      ...this.summary(b),
      scene: b.scene,
      texts: boardTexts({ elements: liveElements(b.scene) }),
    }
  }
}

/** Two team boards for the pilot launch. */
export function seedBoards(fake: FakeBoards, now = Date.now()): void {
  fake.add({
    space: 'team',
    id: seedId('BRD', 1),
    title: 'Pilot launch plan',
    scene: launchPlanScene(),
    by: PRIYA.email,
    at: now - 2 * DAY,
    updatedBy: SAM.email,
  })
  fake.add({
    space: 'team',
    id: seedId('BRD', 2),
    title: 'Onboarding retro, week 2',
    scene: retroScene(),
    by: SAM.email,
    at: now - 5 * DAY,
  })
}

/** One board in the member's own space, so "My boards" isn't empty. */
function seedPersonalBoard(fake: FakeBoards, user: FakeUser): void {
  fake.add({
    space: user.handle,
    id: seedId('BRDP', 1),
    title: 'Pilot review agenda',
    scene: agendaScene(),
    by: user.email,
    at: Date.now() - DAY / 2,
  })
}

/** Every image a scene points at must be a file in the space's assets folder. */
function badFiles(scene: BoardScene): boolean {
  return Object.values(scene.files).some(
    (f) =>
      !f.path.startsWith(`${SPACE_LAYOUT.assets}/`) ||
      f.path.split('/').some((s) => s === '..' || s === ''),
  )
}

export interface BoardHandlerDeps {
  boards: FakeBoards
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
  seeded: boolean
}

export function boardHandlers(deps: BoardHandlerDeps): AnyHandler[] {
  const { boards: fake, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  const canAccess = (user: FakeUser, space: string) => space === 'team' || space === user.handle
  const forbidden = (space: string) =>
    error(403, 'forbidden', `You don't have access to the space "${space}"`)

  type Args = { request: Request; user: FakeUser; params: Record<string, unknown>; url: URL }
  const authed =
    (fn: (args: Args) => Response | Promise<Response>) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      if (deps.seeded && !fake.seeded.has(user.email)) {
        fake.seeded.add(user.email)
        seedPersonalBoard(fake, user)
      }
      return fn({ request, user, params, url: new URL(request.url) })
    }

  const one = (user: FakeUser, params: Record<string, unknown>): FakeBoard | Response => {
    const space = String(params.space)
    const id = String(params.id)
    if (!canAccess(user, space)) return forbidden(space)
    const board = BOARD_ID.test(id) ? fake.get(space, id) : undefined
    return board ?? error(404, 'not_found', `No board ${id} in ${space}`)
  }

  /** The request's scene, checked like the server's schema; a Response when it's refused. */
  const sceneOf = (raw: unknown): BoardScene | Response | undefined => {
    if (raw === undefined) return undefined
    const parsed = BoardScene.safeParse(raw)
    if (!parsed.success) {
      return error(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Not a board scene')
    }
    if (badFiles(parsed.data)) {
      return error(
        400,
        'bad_request',
        `A board's images must be files under ${SPACE_LAYOUT.assets}/`,
      )
    }
    return parsed.data
  }

  const socketHandler = boardSocket.addEventListener('connection', ({ client }) => {
    let ready = false
    const timer = setTimeout(() => {
      if (!ready) client.close(4401, 'auth timeout')
    }, 5000)
    client.addEventListener('message', (event) => {
      if (ready) return // Alone in the room: scene and pointer messages go nowhere.
      let message: { type?: string; devUser?: unknown; token?: unknown } = {}
      try {
        message = JSON.parse(String(event.data))
      } catch {
        // Falls through to the refusal below.
      }
      clearTimeout(timer)
      if (message.type !== 'auth') {
        client.close(4401, 'unauthorized')
        return
      }
      ready = true
      const email = typeof message.devUser === 'string' ? message.devUser : 'ada@example.test'
      const name = email.split('@')[0] ?? email
      client.send(JSON.stringify({ type: 'ready', you: { id: 'p1', name, email }, peers: [] }))
    })
    client.addEventListener('close', () => clearTimeout(timer))
  })

  return [
    socketHandler,

    http.get(
      '/api/boards',
      authed(({ user, url }) => {
        const space = url.searchParams.get('space')
        if (space && !canAccess(user, space)) return forbidden(space)
        const q = url.searchParams.get('q')?.trim().toLowerCase()
        const terms = q ? q.split(/\s+/) : []
        const boards = [...fake.boards.values()]
          .filter((b) => canAccess(user, b.space) && (!space || b.space === space))
          .filter((b) => {
            if (terms.length === 0) return true
            const hay = [b.title, ...boardTexts({ elements: liveElements(b.scene) })]
              .join('\n')
              .toLowerCase()
            return terms.every((t) => hay.includes(t))
          })
          .sort((a, b) => b.updated.localeCompare(a.updated) || b.id.localeCompare(a.id))
          .map((b) => fake.summary(b))
        return HttpResponse.json({ boards })
      }),
    ),

    http.post(
      '/api/boards',
      authed(async ({ request, user }) => {
        const body = (await request.json().catch(() => ({}))) as {
          title?: string
          space?: string
          scene?: unknown
        }
        const space = body.space ?? user.handle
        if (!canAccess(user, space)) return forbidden(space)
        const scene = sceneOf(body.scene)
        if (scene instanceof Response) return scene
        const board = fake.add({ space, title: body.title, scene, by: user.email })
        return HttpResponse.json(fake.view(board), { status: 201 })
      }),
    ),

    http.get(
      '/api/boards/:space/:id',
      authed(({ user, params }) => {
        const board = one(user, params)
        return board instanceof Response ? board : HttpResponse.json(fake.view(board))
      }),
    ),

    http.put(
      '/api/boards/:space/:id',
      authed(async ({ request, user, params }) => {
        const board = one(user, params)
        if (board instanceof Response) return board
        const body = (await request.json().catch(() => ({}))) as {
          scene?: unknown
          title?: string
          baseBlobOid?: string
        }
        const input = sceneOf(body.scene)
        if (input instanceof Response) return input
        let scene = board.scene
        let merged = false
        if (input) {
          if (body.baseBlobOid && body.baseBlobOid === board.blobOid) {
            // A save sends only the canvas settings it changed.
            scene = { ...input, appState: { ...board.scene.appState, ...input.appState } }
          } else {
            scene = mergeScenes(board.scene, input)
            merged = true
          }
          scene = tidyScene(scene)
        }
        const sceneChanged =
          input !== undefined && JSON.stringify(scene) !== JSON.stringify(board.scene)
        const title = body.title === undefined ? undefined : boardTitle(body.title)
        const titleChanged = title !== undefined && title !== board.title
        if (sceneChanged || titleChanged) {
          board.scene = scene
          if (title !== undefined) board.title = title
          board.updated = iso(Date.now())
          board.updatedBy = user.email.toLowerCase()
          board.blobOid = newId().toLowerCase()
        }
        return HttpResponse.json({ ...fake.view(board), merged })
      }),
    ),

    http.delete(
      '/api/boards/:space/:id',
      authed(({ user, params }) => {
        const board = one(user, params)
        if (board instanceof Response) return board
        fake.boards.delete(fake.key(board.space, board.id))
        return new HttpResponse(null, { status: 204 })
      }),
    ),
  ]
}
