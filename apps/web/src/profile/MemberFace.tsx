import { usePhotoSrc } from './photo'

/** Initials for a face: "Ada Lovelace" → "AL"; the email's first letter without a name. */
export function initials(name: string | undefined, email: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    const first = words[0]?.[0] ?? ''
    const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : ''
    return (first + last).toUpperCase()
  }
  return (email?.[0] ?? '?').toUpperCase()
}

/** A member's face on a disc: their photo, or their initials until it loads or without one. */
export function MemberFace({
  name,
  email,
  photo,
  className = 'size-7.5 text-[0.6875rem]',
}: {
  name: string | undefined
  email: string | undefined
  /** The photo's address (`Me.photo`), or null. */
  photo?: string | null | undefined
  className?: string
}) {
  const src = usePhotoSrc(photo)
  return (
    <span
      aria-hidden="true"
      data-testid="member-face"
      data-photo={src ? '' : undefined}
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-ash-strong font-semibold text-paper-raised ${className}`}
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : initials(name, email)}
    </span>
  )
}
