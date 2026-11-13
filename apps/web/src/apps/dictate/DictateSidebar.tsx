import { Link } from 'react-router'
import { Icon, type IconName } from '../../components/Icon'
import { MAC_APP_SETTINGS } from '../../components/MacApp'

/** Hearth Dictate's sidebar: voice notes, the Mac page's sections, then the app's download. */
export function DictateSidebar() {
  return (
    <nav aria-label="Dictate" className="mt-1 px-2">
      <Item href="/dictate/voice" icon="mic" label="Voice notes" />
      <Item href="/dictate/mac#get-it" icon="check" label="Connect this Mac" />
      <Item href="/dictate/mac#devices" icon="tab" label="Connected Macs" />
      <Item href="/dictate/mac#words" icon="book" label="Words" />
      <Item href={MAC_APP_SETTINGS} icon="download" label="Get the Mac app" />
    </nav>
  )
}

function Item({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  return (
    <Link
      to={href}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-ink-soft hover:bg-paper-sunk/70 hover:text-ink"
    >
      <Icon name={icon} className="size-4 text-ink-faint" />
      {label}
    </Link>
  )
}
