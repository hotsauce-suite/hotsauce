import { type FormEvent, useEffect, useState } from 'react'
import { type AssistantSettings, assistantApi, type MemberUsage } from '../../api/assistant'
import { primaryButton } from '../../apps/meetings/components/common'
import { Field, inputClass } from './fields'

const dollars = (n: number) =>
  n < 0.01 && n > 0 ? 'under $0.01' : `$${n.toFixed(2).replace(/\.00$/, '')}`

/**
 * Settings → Organization: the assistant's model, an optional monthly limit per member, and this
 * month's usage per member (docs/PLAN-assistant.md R11, R12). Saved on its own and live at once.
 */
export function AssistantSection() {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [members, setMembers] = useState<MemberUsage[] | null>(null)
  const [model, setModel] = useState('')
  const [limit, setLimit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    assistantApi.settings().then(
      (s) => {
        setSettings(s)
        setModel(s.model)
        setLimit(s.monthlyLimitUsd ? String(s.monthlyLimitUsd) : '')
      },
      (err) =>
        setError(err instanceof Error ? err.message : 'Couldn’t load the assistant settings'),
    )
    assistantApi.usage().then(
      (u) => setMembers(u.members),
      () => setMembers([]),
    )
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = limit.trim() === '' ? 0 : Number(limit)
    if (!Number.isFinite(n) || n < 0) {
      setError('The limit is a dollar amount, or empty for no limit.')
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const next = await assistantApi.saveSettings({
        ...(settings?.fromEnv.model ? {} : { model }),
        ...(settings?.fromEnv.monthlyLimitUsd ? {} : { monthlyLimitUsd: n }),
      })
      setSettings(next)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save')
    } finally {
      setBusy(false)
    }
  }

  const total = (members ?? []).reduce((sum, m) => sum + m.costUsd, 0)
  return (
    <form
      onSubmit={(e) => void submit(e)}
      data-testid="org-assistant"
      className="flex flex-col gap-5"
      noValidate
    >
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Assistant
        </h2>
        <p className="mt-2 text-ink-soft">
          Members ask the assistant from any page (⌘J, or Ctrl+J on Windows). It uses the Anthropic
          key above, works only with what each member can already see, and their conversations are
          private to them.
        </p>
      </div>
      <Field label="Model" locked={settings?.fromEnv.model}>
        {(id) => (
          <select
            id={id}
            data-testid="assistant-model"
            className={inputClass}
            value={model}
            disabled={!settings || settings.fromEnv.model}
            onChange={(e) => setModel(e.target.value)}
          >
            {(settings?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {settings && !settings.models.some((m) => m.id === model) ? (
              <option value={model}>{model}</option>
            ) : null}
          </select>
        )}
      </Field>
      <Field
        label="Monthly limit per member, in US dollars"
        hint="Leave empty for no limit. A member who reaches it is told so until next month. Costs are estimates from Anthropic’s list prices."
        locked={settings?.fromEnv.monthlyLimitUsd}
      >
        {(id) => (
          <input
            id={id}
            data-testid="assistant-limit"
            className={inputClass}
            inputMode="decimal"
            placeholder="No limit"
            value={limit}
            disabled={!settings || settings.fromEnv.monthlyLimitUsd}
            onChange={(e) => setLimit(e.target.value)}
          />
        )}
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button type="submit" className={primaryButton} disabled={busy || !settings}>
          Save
        </button>
        {saved ? <span className="text-sm text-ink-soft">Saved. It applies at once.</span> : null}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-ink">This month’s use</h3>
        {members === null ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-ink-faint" data-testid="assistant-usage-empty">
            Nobody has asked the assistant anything this month.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="assistant-usage">
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="py-1 font-normal">Member</th>
                <th className="py-1 text-right font-normal">Questions</th>
                <th className="py-1 text-right font-normal">Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.email} className="border-t border-ash text-ink">
                  <td className="py-1.5">{m.name || m.email}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.questions}</td>
                  <td className="py-1.5 text-right tabular-nums">{dollars(m.costUsd)}</td>
                </tr>
              ))}
              <tr className="border-t border-ash-strong font-medium text-ink">
                <td className="py-1.5">Everyone</td>
                <td className="py-1.5 text-right tabular-nums">
                  {members.reduce((sum, m) => sum + m.questions, 0)}
                </td>
                <td className="py-1.5 text-right tabular-nums">{dollars(total)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </form>
  )
}
