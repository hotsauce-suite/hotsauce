import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// People (ARCHITECTURE §17, plan P7): open a meeting note, click an attendee, see their page with
// that meeting, write an About line, reload, and it's still there.

test('P7: attendee → person page → About survives a reload', async ({ page, member }) => {
  const id = uid()
  const email = `guest-${id}@partner-${id}.test`
  const title = `Partner intro ${id}`
  // A team meeting: the team can see Gia, so she can have a team note.
  const path = `meetings/2026/11/partner-${id}.md`
  const content = [
    '---',
    'type: meeting',
    `title: ${title}`,
    `date: ${new Date(Date.now() - 86_400_000).toISOString()}`,
    'attendees:',
    `  - ${member.name} <${member.email}>`,
    `  - Gia Guest <${email}>`,
    '---',
    `# ${title}`,
    '',
    'Talked pilots.',
    '',
  ].join('\n')
  const put = await member.request.put(`/api/spaces/${member.team}/file`, {
    data: { path, content },
  })
  expect(put.status(), await put.text()).toBeLessThan(300)

  await page.goto(`/meetings/${member.team}/${path}`)
  await page.getByTestId('meeting-attendee').filter({ hasText: 'Gia Guest' }).click()
  await expect(page).toHaveURL(new RegExp(`/people/${encodeURIComponent(email)}$`))

  const person = page.getByTestId('person-page')
  await expect(person.getByText('Gia Guest').first()).toBeVisible()
  await expect(person.getByTestId('person-meeting').filter({ hasText: title })).toBeVisible()

  const about = `Leads partnerships ${id}.`
  await person.getByTestId('person-about-edit').click()
  await person.getByTestId('person-about-input').fill(about)
  await person.getByTestId('person-about-save').click()
  await expect(person.getByTestId('person-about-text')).toHaveText(about)

  await page.reload()
  await expect(page.getByTestId('person-about-text')).toHaveText(about)

  // They're on the People list too.
  await page.goto('/people')
  await page.getByTestId('people-search').fill(id)
  await expect(page.getByTestId('people-row')).toHaveCount(1)
  await expect(page.getByTestId('people-row')).toHaveAttribute('data-email', email)
})
