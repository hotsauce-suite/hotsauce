import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// An upright iPad Air (docs/PLAN-ipad.md): a meeting opens on its notes; the transcript is a tap away.
function meetingNote(title: string, date: string, body: string): string {
  return `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees: []\n---\n# ${title}\n\n${body}\n`
}

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

test('T1: on an upright iPad a meeting opens on its notes, with the transcript over them on a tap', async ({
  page,
  member,
}) => {
  const id = uid()
  const path = `meetings/2026/11/2026-11-07-site-visit-${id}.md`
  await member.api.writeFile(
    member.personal,
    path,
    meetingNote(
      `Site visit ${id}`,
      '2026-11-07T10:00:00Z',
      '## Summary\n\nThe loading dock is ready.',
    ),
  )
  await page.goto(`/meetings/${member.personal}/${path}`)
  const editor = page.getByTestId('editor-content')
  await expect(editor).toContainText('The loading dock is ready.')
  await expect(page.getByTestId('transcript-panel')).toBeHidden()
  const width = (await editor.boundingBox())?.width ?? 0
  expect(width).toBeGreaterThan(400)
  await page.getByTestId('transcript-toggle').tap()
  await expect(page.getByTestId('transcript-panel')).toBeInViewport({ ratio: 1 })
  expect((await editor.boundingBox())?.width).toBe(width)
})
