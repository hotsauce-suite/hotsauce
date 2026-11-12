import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { memberTimeZone, tasksApi } from '../../api/tasks'
import { Icon, type IconName } from '../../components/Icon'
import { useSession } from '../../state/session'
import { projectUrl, todayIn } from './logic'
import { tasksBus, useTasksChanged } from './useTaskList'
import { useProjects } from './useTaskMeta'

/** Today's open count: mine, open, due today or before. */
function useTodayCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  const load = useCallback(() => {
    const today = todayIn(memberTimeZone())
    tasksApi.list({ mine: true, status: 'open', dueBefore: today }).then(
      (tasks) => setCount(tasks.length),
      () => {},
    )
  }, [])
  useEffect(load, [load])
  useTasksChanged(load)
  return count
}

/** Hearth Tasks' sidebar: Add task, the lists, the projects of each space, import. */
export function TasksSidebar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const session = useSession()
  const projects = useProjects()
  const todayCount = useTodayCount()

  const bySpace = useMemo(() => {
    const groups = new Map<string, typeof projects>()
    for (const p of projects) groups.set(p.space, [...(groups.get(p.space) ?? []), p])
    // Team first, then the member's own.
    const order = (space: string) =>
      session.spaces.find((s) => s.name === space)?.kind === 'team' ? 0 : 1
    return [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([space, list]) => ({
        space,
        list: [...list].sort((x, y) => x.name.localeCompare(y.name)),
      }))
  }, [projects, session.spaces])

  const addTask = () => {
    if (pathname.startsWith('/tasks') && pathname !== '/tasks/import') {
      tasksBus.emit({ type: 'quick-add' })
    } else {
      navigate('/tasks', { state: { quickAdd: true } })
    }
  }

  return (
    <>
      <div className="px-3">
        <button
          type="button"
          data-testid="tasks-sidebar-add"
          onClick={addTask}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-ember text-sm font-medium text-paper-raised hover:bg-ember-strong"
        >
          <Icon name="plus" />
          Add task
          <kbd className="ml-1 rounded border border-paper-raised/40 px-1 font-mono text-[0.65rem] text-paper-raised/85">
            q
          </kbd>
        </button>
      </div>

      <nav aria-label="Task lists" className="mt-3 px-2">
        <NavItem to="/tasks" icon="inbox" label="Inbox" active={pathname === '/tasks'} />
        <NavItem
          to="/tasks/today"
          icon="today"
          label="Today"
          count={todayCount}
          testId="tasks-nav-today"
          active={pathname === '/tasks/today'}
        />
        <NavItem
          to="/tasks/upcoming"
          icon="upcoming"
          label="Upcoming"
          active={pathname === '/tasks/upcoming'}
        />
        <NavItem
          to="/tasks/all"
          icon="tasks"
          label="All tasks"
          testId="tasks-nav-all"
          active={pathname === '/tasks/all'}
        />
        <NavItem to="/tasks/done" icon="check" label="Done" active={pathname === '/tasks/done'} />
      </nav>

      <section
        aria-label="Projects"
        className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-ash/70 px-2 pt-2 pb-2"
      >
        <h3 className="px-2 pt-1 pb-1 text-xs font-semibold text-ink-faint">Projects</h3>
        {projects.length === 0 ? (
          <p className="px-2 text-xs text-ink-faint">
            Add #project to a task and the project shows up here.
          </p>
        ) : null}
        {bySpace.map(({ space, list }) => (
          <div key={space} className="mb-2">
            <p className="px-2 pt-1 text-[0.68rem] font-medium tracking-wide text-ink-faint uppercase">
              {session.spaceLabel(space)}
            </p>
            <ul>
              {list.map((p) => {
                const to = projectUrl(p.space, p.name)
                return (
                  <li key={`${p.space}:${p.name}`}>
                    <NavItem
                      to={to}
                      icon="hash"
                      label={p.name}
                      count={p.open}
                      testId="tasks-nav-project"
                      active={decodeURIComponent(pathname) === decodeURIComponent(to)}
                    />
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </section>

      <div className="shrink-0 border-t border-ash/70 px-2 py-2">
        <NavItem
          to="/tasks/import"
          icon="upload"
          label="Import from Todoist"
          active={pathname === '/tasks/import'}
        />
      </div>
    </>
  )
}

function NavItem({
  to,
  icon,
  label,
  active,
  count,
  testId,
}: {
  to: string
  icon: IconName
  label: string
  active: boolean
  count?: number | null
  testId?: string
}) {
  return (
    <Link
      to={to}
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-sm ${
        active
          ? 'bg-paper/70 font-medium text-ink'
          : 'text-ink-soft hover:bg-paper/70 hover:text-ink'
      }`}
    >
      <Icon name={icon} className="size-4 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span
          data-testid="nav-count"
          className="shrink-0 text-[0.72rem] text-ink-faint tabular-nums"
        >
          {count}
        </span>
      ) : null}
    </Link>
  )
}
