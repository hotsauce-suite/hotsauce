import type { PushSender } from '../meetings/reminders/sender.js'
import type { ReminderStore, Subscriber } from '../meetings/reminders/store.js'
import type { Tasks, TaskView } from './service.js'

const TICK_MS = 30_000
/** A task is reminded when its due time is at most this far behind (a server that was down)… */
export const TASK_REMINDER_LATE_MS = 10 * 60_000
/** …or this far ahead, one tick. */
export const TASK_REMINDER_LEAD_MS = 30_000

/** Once per member, task and due time: a task moved to a new time is reminded again. */
export function taskReminderKey(email: string, task: Pick<TaskView, 'id' | 'dueAt'>): string {
  return `task ${email} ${task.id} ${task.dueAt}`
}

/** Open timed tasks of the member's own that fall due in `(now − 10 min, now + 30 s]`. */
export function dueForReminder(tasks: readonly TaskView[], now: Date): TaskView[] {
  const t = now.getTime()
  return tasks.filter((task) => {
    if (task.status !== 'open' || !task.mine || task.dueAt === null) return false
    const at = Date.parse(task.dueAt)
    return at > t - TASK_REMINDER_LATE_MS && at <= t + TASK_REMINDER_LEAD_MS
  })
}

/**
 * Hearth Tasks reminders (ARCHITECTURE §12.2): a web push when a timed task of yours falls due,
 * to every browser that turned on meeting reminders. Checked every 30 seconds; each task and due
 * time once per member.
 */
export class TaskReminders {
  readonly #store: ReminderStore
  readonly #sender: PushSender
  readonly #tasks: Pick<Tasks, 'list' | 'accessibleSpaces'>
  readonly #now: () => Date
  readonly #log: (message: string) => void
  #timer: ReturnType<typeof setInterval> | null = null
  #running: Promise<void> | null = null

  constructor(opts: {
    store: ReminderStore
    sender: PushSender
    tasks: Pick<Tasks, 'list' | 'accessibleSpaces'>
    now?: () => Date
    log?: (message: string) => void
  }) {
    this.#store = opts.store
    this.#sender = opts.sender
    this.#tasks = opts.tasks
    this.#now = opts.now ?? (() => new Date())
    this.#log = opts.log ?? console.error
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await this.#running
  }

  /** One pass; a pass still running is joined rather than doubled. */
  tick(): Promise<void> {
    this.#running ??= this.#tick().finally(() => {
      this.#running = null
    })
    return this.#running
  }

  async #tick(): Promise<void> {
    const now = this.#now()
    const byMember = new Map<string, Subscriber[]>()
    for (const s of await this.#store.subscribers()) {
      byMember.set(s.principal.email, [...(byMember.get(s.principal.email) ?? []), s])
    }
    for (const [email, subs] of byMember) {
      const principal = subs[0]?.principal
      if (!principal) continue
      try {
        // Spaces from the registry, not this process's provisioning, so a member who hasn't
        // opened Hearth since a restart still gets reminded of personal tasks.
        // Only timed tasks in the window, so the list's limit never drops one that's due.
        const open = await this.#tasks.list(
          principal,
          {
            status: 'open',
            mine: true,
            dueAtAfter: new Date(now.getTime() - TASK_REMINDER_LATE_MS).toISOString(),
            dueAtUntil: new Date(now.getTime() + TASK_REMINDER_LEAD_MS).toISOString(),
          },
          { spaces: this.#tasks.accessibleSpaces(principal) },
        )
        for (const task of dueForReminder(open, now)) {
          const key = taskReminderKey(email, task)
          if (await this.#store.wasSent(key)) continue
          const payload = {
            title: `Due now: ${task.title}`,
            body: task.project ?? 'Tasks',
            url: '/tasks/today',
            tag: `task-${task.id}`,
          }
          let delivered = false
          for (const sub of subs) {
            try {
              const result = await this.#sender.send(sub.subscription, payload)
              if (result === 'gone') await this.#store.unsubscribe(sub.subscription.endpoint)
              else delivered = true
            } catch (err) {
              this.#log(`task push to ${email} failed: ${err}`)
            }
          }
          // Not one browser got it: the next tick tries again while it's inside the window.
          if (delivered) await this.#store.markSent(key, now.getTime())
        }
      } catch (err) {
        this.#log(`task reminders for ${email}: ${err}`)
      }
    }
  }
}
