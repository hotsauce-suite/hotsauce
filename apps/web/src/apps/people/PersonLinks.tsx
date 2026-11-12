import { Fragment } from 'react'
import { Link } from 'react-router'
import { personUrl } from '../../api/people'
import { useSession } from '../../state/session'

/** "Dana Lee <dana@acme.com>" or a bare email → its email, lowercased; null if there is none. */
export function emailOf(attendee: string): string | null {
  const bracketed = /<([^<>]*)>\s*$/.exec(attendee)
  const email = (bracketed?.[1] ?? attendee).trim().toLowerCase()
  return email.includes('@') ? email : null
}

/** Names joined by commas, each linking to its person page (ARCHITECTURE §17.5); not the member's own. */
export function PersonLinks({
  people,
  testId = 'person-link',
}: {
  people: Array<{ email: string | null; name: string }>
  testId?: string
}) {
  const me = useSession().me?.principal.email.toLowerCase()
  return (
    <>
      {people.map((p, i) => (
        <Fragment key={`${p.email ?? ''}|${p.name}`}>
          {i > 0 ? ', ' : null}
          {p.email && p.email !== me ? (
            <Link
              to={personUrl(p.email)}
              className="underline-offset-2 hover:text-ember-strong hover:underline"
              data-testid={testId}
            >
              {p.name}
            </Link>
          ) : (
            p.name
          )}
        </Fragment>
      ))}
    </>
  )
}
