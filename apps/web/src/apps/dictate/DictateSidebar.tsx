import { Icon, type IconName } from '../../components/Icon'

/** Hearth Dictate's sidebar: the page's sections, since the app itself lives on the Mac. */
export function DictateSidebar() {
  return (
    <nav aria-label="Dictate" className="mt-1 px-2">
      <Item href="#get-it" icon="mic" label="Get the Mac app" />
      <Item href="#install" icon="check" label="Installing it" />
      <Item href="#devices" icon="tab" label="Connected Macs" />
      <Item href="#words" icon="book" label="Words" />
    </nav>
  )
}

function Item({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  return (
    <a
      href={href}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-ink-soft hover:bg-paper-sunk/70 hover:text-ink"
    >
      <Icon name={icon} className="size-4 text-ink-faint" />
      {label}
    </a>
  )
}
