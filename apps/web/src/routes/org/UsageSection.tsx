import { useEffect, useState } from 'react'
import { type AppUsage, type UsageReport, usageApi } from '../../api/usage'
import { APPS } from '../../apps/registry'
import { Icon, type IconName } from '../../components/Icon'

/**
 * Settings → Organization → Usage (docs/PLAN-app-usage.md, U11–U12): how much each app was used
 * over the last 12 weeks, counted from the history Hotsauce already keeps. Numbers only.
 */
export function UsageSection() {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    usageApi
      .get()
      .then(setReport, (err: unknown) =>
        setError(err instanceof Error ? err.message : 'Couldn’t load usage'),
      )
  }, [])

  return (
    <section data-testid="org-usage" className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Usage
        </h2>
        <p className="mt-2 text-ink-soft">
          How much each app was used over the last 12 weeks: the things people made or changed, and
          how many different people did it. It’s counted from the history every document already
          keeps, in the team space and everyone’s own space. Nothing is tracked, and this page never
          shows names or titles.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-ember-strong">
          {error}
        </p>
      ) : null}
      {report === null && !error ? <p className="text-sm text-ink-faint">Counting…</p> : null}
      {report ? <UsageList report={report} /> : null}
    </section>
  )
}

function UsageList({ report }: { report: UsageReport }) {
  const max = Math.max(1, ...report.apps.flatMap((a) => a.weeks.map((w) => w.changed)))
  const used = report.apps.filter((a) => a.total.changed > 0)
  const unused = report.apps.filter((a) => a.total.changed === 0)
  const first = report.weeks[0]
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-faint">
        Weeks start on Monday{first ? `, from ${formatWeek(first)}` : ''}. The last bar is this week
        so far. Every chart uses the same scale.
      </p>
      <ul className="flex flex-col divide-y divide-ash" data-testid="usage-apps">
        {used.map((app) => (
          <AppRow key={app.id} app={app} max={max} />
        ))}
      </ul>
      {unused.length > 0 ? (
        <p className="text-sm text-ink-soft" data-testid="usage-unused">
          Nothing made or changed in 12 weeks: {unused.map((a) => appLabel(a.id)).join(', ')}.
        </p>
      ) : null}
      <div className="flex flex-col gap-1 text-sm text-ink-soft" data-testid="usage-notes">
        <p data-testid="usage-dictate">
          <span className="font-medium text-ink">Dictate</span> keeps its history on each Mac and
          never sends it here.{' '}
          {report.dictate.connectedMacs === 0
            ? 'No Mac is connected.'
            : `${plural(report.dictate.connectedMacs, 'Mac')} connected, ${report.dictate.usedLast7Days} used in the last 7 days.`}
        </p>
        <p>
          <span className="font-medium text-ink">Today</span> and{' '}
          <span className="font-medium text-ink">Chat</span> aren’t counted: Today makes nothing,
          and Chat runs on its own server.
        </p>
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-ink-soft">
          Show the numbers as a table
        </summary>
        <UsageTable report={report} />
      </details>
    </div>
  )
}

function AppRow({ app, max }: { app: AppUsage; max: number }) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
      data-testid={`usage-${app.id}`}
    >
      <div className="flex w-36 items-center gap-2 text-ink">
        <Icon name={appIcon(app.id)} />
        <span className="font-medium">{appLabel(app.id)}</span>
      </div>
      <WeekBars app={app} max={max} />
      <div className="text-sm text-ink-soft">
        <span className="font-medium text-ink">{plural(app.total.changed, 'item')}</span> made or
        changed ({app.total.created} new) ·{' '}
        {app.peopleLast4Weeks === 0
          ? 'nobody in the last 4 weeks'
          : `${plural(app.peopleLast4Weeks, 'person', 'people')} in the last 4 weeks`}
      </div>
    </li>
  )
}

const BAR = 8
const GAP = 2
const HEIGHT = 32

/** One bar a week of items made or changed; hover or focus a bar for its numbers. */
function WeekBars({ app, max }: { app: AppUsage; max: number }) {
  const width = app.weeks.length * (BAR + GAP) - GAP
  const peak = app.weeks.reduce((m, w) => Math.max(m, w.changed), 0)
  return (
    <svg
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      role="img"
      aria-label={`${appLabel(app.id)}: ${app.weeks.map((w) => w.changed).join(', ')} items a week, oldest first; most in a week ${peak}`}
      className="shrink-0 overflow-visible"
    >
      <line x1={0} x2={width} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-ash" />
      {app.weeks.map((w, i) => {
        const h = w.changed === 0 ? 0 : Math.max(2, (w.changed / max) * (HEIGHT - 1))
        const x = i * (BAR + GAP)
        return (
          <g key={w.week}>
            <title>{`Week of ${formatWeek(w.week)}: ${plural(w.changed, 'item')} made or changed, ${w.created} new, by ${plural(w.people, 'person', 'people')}`}</title>
            {/* The hit target is the whole column, taller than the bar. */}
            <rect x={x - GAP / 2} y={0} width={BAR + GAP} height={HEIGHT} fill="transparent" />
            {h > 0 ? (
              <path
                d={roundedTop(x, HEIGHT - 1 - h, BAR, h, Math.min(3, h))}
                className="fill-ember"
              />
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

/** A bar with rounded top corners, square on the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function UsageTable({ report }: { report: UsageReport }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="text-sm text-ink" data-testid="usage-table">
        <caption className="sr-only">Items made or changed each week, by app</caption>
        <thead>
          <tr>
            <th scope="col" className="pr-3 text-left font-medium">
              App
            </th>
            {report.weeks.map((w) => (
              <th key={w} scope="col" className="px-1 text-right font-normal text-ink-faint">
                {formatWeek(w)}
              </th>
            ))}
            <th scope="col" className="pl-3 text-right font-medium">
              People (4 wk)
            </th>
          </tr>
        </thead>
        <tbody>
          {report.apps.map((a) => (
            <tr key={a.id}>
              <th scope="row" className="pr-3 text-left font-normal">
                {appLabel(a.id)}
              </th>
              {a.weeks.map((w) => (
                <td key={w.week} className="px-1 text-right tabular-nums">
                  {w.changed}
                </td>
              ))}
              <td className="pl-3 text-right tabular-nums">{a.peopleLast4Weeks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function appLabel(id: string): string {
  if (id === 'pages') return 'Pages'
  return APPS.find((a) => a.id === id)?.label ?? id
}

function appIcon(id: string): IconName {
  if (id === 'pages') return 'file'
  return APPS.find((a) => a.id === id)?.icon ?? 'file'
}

function formatWeek(week: string): string {
  return new Date(`${week}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
