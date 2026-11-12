import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { meetingsApi } from '../../api/meetings'
import { type TaskView, tasksApi } from '../../api/tasks'
import type { MeetingActionItems } from '../../api/types'
import { hearthSocket } from '../../api/ws'
import { Icon } from '../../components/Icon'
import { meetingUrl } from '../../lib/paths'
import { errorMessage, useTasksChanged } from './useTaskList'

interface Item {
  key: string
  space: string
  path: string
  title: string
  line: number
  text: string
}

function itemsOf(list: MeetingActionItems[]): Item[] {
  return list.flatMap((m) =>
    m.items.map((i) => ({
      key: `${m.space}:${m.path}:${i.line}`,
      space: m.space,
      path: m.path,
      title: m.title,
      line: i.line,
      text: i.text,
    })),
  )
}

/**
 * Today's "From your meetings": open `- [ ]` items from the member's meetings that aren't tasks
 * yet. The checkbox ticks the line in the note; Add to tasks makes it a task due today, and
 * completing that task later ticks the note too (the server does).
 */
export function FromMeetings({
  today,
  tz,
  onAdded,
  onError,
}: {
  today: string
  tz: string
  onAdded: (task: TaskView) => void
  onError: (message: string) => void
}) {
  const [items, setItems] = useState<Item[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(() => {
    tasksApi.fromMeetings().then(
      (list) => {
        if (Array.isArray(list)) setItems(itemsOf(list))
        setLoaded(true)
      },
      // A convenience: if it can't load, the section stays hidden.
      () => setLoaded(true),
    )
  }, [])

  useEffect(load, [load])
  useTasksChanged(load)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = hearthSocket.onChanged((event) => {
      if (!event.paths.some((p) => p.startsWith('meetings/'))) return
      clearTimeout(timer)
      timer = setTimeout(load, 2000)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [load])

  const take = async (item: Item, run: () => Promise<void>) => {
    setItems((all) => all.filter((i) => i.key !== item.key))
    try {
      await run()
    } catch (err) {
      setItems((all) => (all.some((i) => i.key === item.key) ? all : [item, ...all]))
      onError(errorMessage(err))
    }
  }

  const tick = (item: Item) =>
    take(item, async () => {
      await meetingsApi.completeActionItem({
        space: item.space,
        path: item.path,
        line: item.line,
        text: item.text,
      })
    })

  const add = (item: Item) =>
    take(item, async () => {
      const task = await tasksApi.create({
        title: item.text,
        due: today,
        tz,
        source: {
          kind: 'meeting',
          space: item.space,
          path: item.path,
          line: item.line,
          text: item.text,
        },
      })
      onAdded(task)
    })

  if (!loaded || items.length === 0) return null

  return (
    <section aria-labelledby="from-meetings" data-testid="from-meetings" className="mt-10">
      <h2
        id="from-meetings"
        className="mb-2 flex items-baseline gap-2 font-display text-[1.25rem] font-semibold tracking-tight"
      >
        From your meetings
        <span className="font-ui text-sm font-normal text-ink-faint">{items.length}</span>
      </h2>
      <ul className="divide-y divide-ash/60 rounded-xl border border-ash bg-paper-raised/50">
        {items.map((item) => (
          <li
            key={item.key}
            data-testid="meeting-item"
            className="flex items-start gap-3 px-3 py-2.5 sm:px-4"
          >
            <input
              type="checkbox"
              aria-label={`Mark done in the note: ${item.text}`}
              onChange={() => void tick(item)}
              className="mt-1 size-4 shrink-0 accent-ember"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[0.95rem] text-ink">{item.text}</span>
              <Link
                to={`${meetingUrl(item.space, item.path)}#L${item.line}`}
                className="inline-flex max-w-full items-center gap-1 truncate text-[0.8rem] text-ink-faint hover:text-ink"
              >
                <Icon name="calendar" className="size-3 shrink-0" />
                <span className="truncate">{item.title}</span>
              </Link>
            </span>
            <button
              type="button"
              data-testid="meeting-item-add"
              onClick={() => void add(item)}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-ash px-2.5 text-sm text-ink-soft hover:border-ember hover:text-ink"
            >
              <Icon name="plus" className="size-3.5" />
              <span className="hidden sm:inline">Add to tasks</span>
              <span className="sm:hidden">Add</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
