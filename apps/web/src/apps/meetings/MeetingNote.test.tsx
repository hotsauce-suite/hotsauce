import { EditorView } from '@codemirror/view'
import { parseFrontmatter } from '@hearth/format'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { meetingsApi } from '../../api/meetings'
import { PANES_QUERY } from '../../hooks/useMediaQuery'
import { PRIYA } from '../../mocks/seed'
import { mockApi, server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'

/** The seeded "Acme kickoff" note in the member's personal space. */
async function acmeKickoff(): Promise<string> {
  const list = await meetingsApi.list({ space: 'ada' })
  const note = list.find((m) => m.title === 'Acme kickoff')
  if (!note) throw new Error('seed is missing Acme kickoff')
  return note.path
}

/** Replaces the first `find` in the open document's editor, as a keystroke would. */
function replaceInEditor(find: string, replace: string) {
  const view = EditorView.findFromDOM(screen.getByTestId('editor-content'))
  if (!view) throw new Error('no editor')
  const from = view.state.doc.toString().indexOf(find)
  if (from === -1) throw new Error(`no ${find} in the editor`)
  act(() => view.dispatch({ changes: { from, to: from + find.length, insert: replace } }))
}

/** The editor line showing `text` (live preview draws list and heading markers as widgets). */
const lineWith = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('.cm-line')].find((l) => l.textContent?.includes(text))

/** A laptop-wide window, or an upright iPad's (docs/PLAN-ipad.md), as far as media queries go. */
function setWide(wide: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches: query === PANES_QUERY ? wide : false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

describe('Meeting note page', () => {
  const original = window.matchMedia
  beforeEach(() => setWide(true))
  afterEach(() => {
    window.matchMedia = original
  })

  it('mutes the AI-written lines from ai_ranges and leaves the member’s own lines alone', async () => {
    const path = await acmeKickoff()
    renderApp(`/meetings/ada/${path}`)
    await waitFor(() => expect(screen.getAllByTestId('ai-text').length).toBeGreaterThan(0))

    // Lines the member typed during the meeting.
    for (const own of ['SSO before rollout', 'pricing ok if annual']) {
      const line = lineWith(own)
      expect(line).toBeDefined()
      expect(line).not.toHaveAttribute('data-testid', 'ai-text')
    }
    // Lines the AI wrote around them.
    const ai = lineWith('Acme runs Okta and won’t onboard any tool without SAML.')
    expect(ai).toHaveAttribute('data-testid', 'ai-text')
    expect(ai).toHaveClass('cm-ai-line')

    // The header reads the frontmatter.
    expect(screen.getByTestId('enhance')).toHaveTextContent('Re-enhance')
    expect(screen.getByTestId('enhance-template')).toHaveValue('customer-call')
    // P6: each attendee but the member links to their person page.
    expect(screen.getByTitle(/Dana Lee/)).toHaveTextContent('Ada Lovelace, Dana Lee')
    expect(
      screen.getAllByTestId('meeting-attendee').map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([['Dana Lee', '/people/dana%40acme.com']])
  })

  it('opens with the transcript beside the note', async () => {
    const path = await acmeKickoff()
    renderApp(`/meetings/ada/${path}`)
    const panel = await screen.findByTestId('transcript-panel')
    await waitFor(() =>
      expect(
        within(panel).getByText('Yes, Okta. IT won’t onboard anything without it.'),
      ).toBeInTheDocument(),
    )
    expect(within(panel).getAllByText('Them').length).toBeGreaterThan(0)
    expect(within(panel).getByText('0:31')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('transcript-toggle'))
    expect(screen.queryByTestId('transcript-panel')).toBeNull()
  })

  it('on an upright iPad, opens on the note with the transcript a tap away', async () => {
    setWide(false)
    const path = await acmeKickoff()
    renderApp(`/meetings/ada/${path}`)
    await screen.findByTestId('transcript-toggle')
    expect(screen.queryByTestId('transcript-panel')).toBeNull()
    await userEvent.click(screen.getByTestId('transcript-toggle'))
    expect(await screen.findByTestId('transcript-panel')).toBeInTheDocument()
  })

  it('finds the transcript from frontmatter `transcript`, not from the note’s file name', async () => {
    const path = await acmeKickoff()
    const space = mockApi().repo.space('ada')
    // Renamed outside Hearth: the transcript kept its name, the frontmatter still points at it.
    const renamed = path.replace(/[^/]+$/, 'kickoff-with-acme.md')
    space.commit(
      new Map([
        [renamed, space.files.get(path) ?? ''],
        [path, null],
      ]),
      PRIYA,
      'rename',
    )
    renderApp(`/meetings/ada/${renamed}`)
    const panel = await screen.findByTestId('transcript-panel')
    await waitFor(() =>
      expect(
        within(panel).getByText('Yes, Okta. IT won’t onboard anything without it.'),
      ).toBeInTheDocument(),
    )
  })

  it('names speakers: confirms Claude’s guess, or picks an attendee for a label', async () => {
    const path = await acmeKickoff()
    const space = mockApi().repo.space('ada')
    const note = space.files.get(path) ?? ''
    const transcriptName = /^transcript: (.*)$/m.exec(note)?.[1] ?? ''
    const transcriptPath = path.replace(/[^/]+$/, transcriptName)
    const transcript = (space.files.get(transcriptPath) ?? '')
      .replace('**Them:** Sure.', '**Speaker 1:** Sure.')
      .replace('**Them:** Yes, Okta.', '**Speaker 2:** Yes, Okta.')
    space.commit(
      new Map([
        [
          path,
          note.replace(
            /^type: meeting$/m,
            'type: meeting\nspeaker_guesses:\n  Speaker 1: Dana Lee',
          ),
        ],
        [transcriptPath, transcript],
      ]),
      PRIYA,
      'diarized',
    )
    const sent: unknown[] = []
    server.use(
      http.post('/api/meetings/speakers', async ({ request }) => {
        sent.push(await request.json())
        return HttpResponse.json({ transcriptPath, renamed: {} })
      }),
    )
    renderApp(`/meetings/ada/${path}`)
    const who = await screen.findByTestId('who-is-who')
    expect(within(who).getByText(/Speaker 1 sounds like/)).toHaveTextContent('Dana Lee')
    await userEvent.click(within(who).getByRole('button', { name: 'Confirm' }))
    await waitFor(() =>
      expect(sent).toEqual([
        {
          space: 'ada',
          path,
          names: { 'Speaker 1': 'Dana Lee' },
          // The transcript the panel shows, so a changed one is refused.
          transcriptBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/),
        },
      ]),
    )

    const panel = screen.getByTestId('transcript-panel')
    await userEvent.click(
      within(panel).getAllByRole('button', { name: 'Speaker 2' })[0] as HTMLElement,
    )
    expect(within(panel).getByText('Who is Speaker 2?')).toBeInTheDocument()
    await userEvent.type(within(panel).getByLabelText('Name'), 'Sam Ortiz')
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(sent[1]).toMatchObject({ space: 'ada', path, names: { 'Speaker 2': 'Sam Ortiz' } }),
    )
    // "Me" is never offered for renaming.
    expect(within(panel).queryByRole('button', { name: 'Me' })).toBeNull()
  })

  it('says there is no transcript when the frontmatter names none', async () => {
    const path = await acmeKickoff()
    const space = mockApi().repo.space('ada')
    const text = (space.files.get(path) ?? '').replace(/^transcript: .*\n/m, '')
    space.commit(new Map([[path, text]]), PRIYA, 'drop transcript')
    renderApp(`/meetings/ada/${path}`)
    const panel = await screen.findByTestId('transcript-panel')
    expect(await within(panel).findByText(/has no transcript/)).toBeInTheDocument()
  })

  it('never offers to rename a meeting note to its title, in Meetings or in Docs', async () => {
    const path = await acmeKickoff()
    for (const url of [`/meetings/ada/${path}`, `/docs/ada/${path}`]) {
      renderApp(url)
      await waitFor(() => expect(screen.getByTestId('editor-content')).toHaveTextContent('SSO'))
      replaceInEditor('# Acme kickoff', '# Acme kickoff, round two')
      // The offer is read once typing pauses (400 ms).
      await act(() => new Promise((resolve) => setTimeout(resolve, 600)))
      expect(screen.queryByTestId('rename-to-title')).toBeNull()
      cleanup()
    }
  })

  it('Enhance commits, calls the API with the picked template, and adopts the result in place', async () => {
    const path = await acmeKickoff()
    const bodies: unknown[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/meetings/enhance') {
        bodies.push(await request.clone().json())
      }
    })
    renderApp(`/meetings/ada/${path}`)
    await screen.findByTestId('enhance')
    await userEvent.selectOptions(screen.getByTestId('enhance-template'), 'general')
    await userEvent.click(screen.getByTestId('enhance'))

    await waitFor(() =>
      expect(screen.getByTestId('editor-content')).toHaveTextContent('More from the transcript'),
    )
    expect(bodies).toEqual([{ space: 'ada', path, template: 'general' }])
    // The member's lines survive, the new AI lines are muted.
    expect(lineWith('SSO before rollout')).not.toHaveAttribute('data-testid', 'ai-text')
    expect(lineWith('Discussion')).toHaveAttribute('data-testid', 'ai-text')
    const saved = mockApi().repo.space('ada').files.get(path) ?? ''
    expect(parseFrontmatter(saved).data).toMatchObject({ template: 'general' })
  })

  it('the note is read-only while Enhance runs, and shows the enhanced text afterwards', async () => {
    const path = await acmeKickoff()
    let finish: () => void = () => {}
    const modelDone = new Promise<void>((resolve) => (finish = resolve))
    // Holds the enhance until the test lets it go, then falls through to the mock's handler.
    server.use(
      http.post('/api/meetings/enhance', async () => {
        await modelDone
      }),
    )
    renderApp(`/meetings/ada/${path}`)
    await screen.findByTestId('enhance')
    const content = await screen.findByTestId('editor-content')
    // Unsaved edits when Enhance is pressed: committed first.
    replaceInEditor('pricing ok if annual', 'pricing ok if annual (typed before)')
    await userEvent.click(screen.getByTestId('enhance'))
    await waitFor(() => expect(content).toHaveAttribute('contenteditable', 'false'))

    await userEvent.type(content, 'typed while enhancing')
    expect(content).not.toHaveTextContent('typed while enhancing')

    finish()
    await waitFor(() => expect(content).toHaveTextContent('More from the transcript'))
    await waitFor(() => expect(content).toHaveAttribute('contenteditable', 'true'))
    expect(mockApi().repo.space('ada').files.get(path)).not.toContain('typed while enhancing')
  })

  it('asks before re-enhancing over edits made since the last enhance', async () => {
    const path = await acmeKickoff()
    const api = mockApi()
    renderApp(`/meetings/ada/${path}`)
    await screen.findByTestId('enhance')
    await userEvent.click(screen.getByTestId('enhance'))
    await waitFor(() => expect(screen.getByTestId('enhance')).toHaveTextContent('Re-enhance'))
    await waitFor(() => expect(screen.getByTestId('enhance')).toBeEnabled())

    // A teammate edits the enhanced note.
    api.repo.outsideEdit('ada', path, {
      author: PRIYA,
      apply: (text) =>
        text.replace('## Summary', '## Summary\nPriya: we owe Dana an answer on SSO.'),
    })
    await userEvent.click(screen.getByTestId('enhance'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Enhancing again replaces those edits')

    await userEvent.click(within(alert).getByText('Re-enhance anyway'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(api.repo.space('ada').files.get(path)).not.toContain('Priya: we owe Dana')
  })

  it('shows an Enhance failure without losing the note', async () => {
    const path = await acmeKickoff()
    server.use(
      http.post('/api/meetings/enhance', () =>
        HttpResponse.json(
          { error: { code: 'llm_error', message: 'The model is busy' } },
          { status: 502 },
        ),
      ),
    )
    renderApp(`/meetings/ada/${path}`)
    await userEvent.click(await screen.findByTestId('enhance'))
    expect(await screen.findByRole('alert')).toHaveTextContent('The model is busy')
    expect(screen.getByTestId('editor-content')).toHaveTextContent('SSO before rollout')
  })

  it('answers questions about this meeting with citations that link to path#line', async () => {
    const path = await acmeKickoff()
    const scopes: unknown[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/meetings/chat') {
        scopes.push(((await request.clone().json()) as { scope: unknown }).scope)
      }
    })
    const { router } = renderApp(`/meetings/ada/${path}`)
    await userEvent.type(
      await screen.findByTestId('meeting-chat-input'),
      'What did Dana say about Okta?',
    )
    await userEvent.click(screen.getByTestId('meeting-chat-send'))

    const answer = await screen.findByTestId('chat-answer')
    const citations = within(answer).getAllByTestId('chat-citation')
    expect(citations.length).toBeGreaterThan(0)
    expect(scopes).toEqual([{ space: 'ada', meetingPath: path }])
    for (const citation of citations) {
      expect(citation.getAttribute('href')).toMatch(
        new RegExp(`^/meetings/ada/${path.replace(/\.md$/, '')}(\\.transcript)?\\.md#L\\d+$`),
      )
    }
    const okta = citations.find((c) => c.textContent?.includes('Okta')) as HTMLElement
    expect(okta).toBeDefined()
    await userEvent.click(okta)
    await waitFor(() => expect(router.state.location.hash).toMatch(/^#L\d+$/))
  })

  it('Ask across meetings sends an unscoped question and cites more than one meeting', async () => {
    renderApp('/meetings/ask')
    await userEvent.type(await screen.findByTestId('meeting-chat-input'), 'assay{Enter}')
    const citations = await screen.findAllByTestId('chat-citation')
    const meetings = new Set(citations.map((c) => c.getAttribute('href')?.split('#')[0]))
    expect(meetings.size).toBeGreaterThan(1)
  })
})
