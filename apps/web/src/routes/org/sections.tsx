import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import type {
  Brand,
  FontChoice,
  KeyTest,
  OrgEditor,
  OrgState,
  SecretName,
  SettingsPatch,
} from '../../api/org'
import { primaryButton, secondaryButton } from '../../apps/meetings/components/common'
import { brandCss, ensureFonts } from '../../brand/applyBrand'
import { HearthMark, Icon } from '../../components/Icon'
import {
  Callout,
  CopyValue,
  Field,
  inputClass,
  messageOf,
  SecretField,
  StepLink,
  TestResult,
} from './fields'

/**
 * The organization editor's sections (ARCHITECTURE §11.2). The setup wizard shows them one per
 * step; Settings → Organization shows them all. Each saves on its own.
 */

export interface SectionProps {
  state: OrgState
  editor: OrgEditor
  onState: (next: OrgState) => void
  /** The save button's label: "Continue" in the wizard, "Save" in Settings. */
  submitLabel: string
  /** Called after a successful save (the wizard moves to the next step). */
  onDone?: (() => void) | undefined
  /** Extra buttons beside the save button (the wizard's Back and Skip). */
  actions?: ReactNode | undefined
}

function SectionForm({
  title,
  intro,
  children,
  busy,
  error,
  submitLabel,
  actions,
  onSubmit,
  testId,
}: {
  title: string
  intro?: ReactNode
  children: ReactNode
  busy: boolean
  error: string | null
  submitLabel: string
  actions?: ReactNode
  onSubmit: () => Promise<void>
  testId: string
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void onSubmit()
  }
  return (
    <form onSubmit={submit} data-testid={testId} className="flex flex-col gap-5" noValidate>
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {intro ? <div className="mt-2 text-ink-soft">{intro}</div> : null}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={busy}
          className={primaryButton}
          data-testid={`${testId}-save`}
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
        {actions}
      </div>
    </form>
  )
}

/** Runs one save; errors land in the section, success moves on. */
function useSave(props: SectionProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<OrgState>) => {
    setBusy(true)
    setError(null)
    try {
      props.onState(await fn())
      props.onDone?.()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run, setError }
}

function useTest(editor: OrgEditor) {
  const [results, setResults] = useState<Partial<Record<string, KeyTest>>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const test = async (
    provider: 'anthropic' | 'deepgram' | 'clerk' | 'github',
    key: string,
    extra?: string,
  ) => {
    setTesting(provider)
    try {
      const r = await editor.test(provider, key || undefined, extra)
      setResults((rs) => ({ ...rs, [provider]: r }))
    } catch (err) {
      setResults((rs) => ({ ...rs, [provider]: { ok: false, message: messageOf(err) } }))
    } finally {
      setTesting(null)
    }
  }
  return { results, testing, test }
}

function TestButton({
  onClick,
  busy,
  testId,
}: {
  onClick: () => void
  busy: boolean
  testId: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      data-testid={testId}
      className={`${secondaryButton} h-9 self-start`}
    >
      {busy ? 'Testing…' : 'Test'}
    </button>
  )
}

/** Only the secrets that were typed; an untouched field keeps the saved one. */
function typedSecrets(values: Partial<Record<SecretName, string>>): SettingsPatch['secrets'] {
  const out: Partial<Record<SecretName, string>> = {}
  for (const [k, v] of Object.entries(values)) if (v?.trim()) out[k as SecretName] = v.trim()
  return Object.keys(out).length ? out : undefined
}

// ── Organization ─────────────────────────────────────────────────────────────────────────────

export function OrgSection(props: SectionProps) {
  const { state } = props
  const s = state.settings
  const locked = state.lockedByEnv
  const [orgName, setOrgName] = useState(s.orgName || state.effective.orgName)
  const [productName, setProductName] = useState(s.productName)
  const [domains, setDomains] = useState(
    (s.allowedDomains.length ? s.allowedDomains : state.effective.allowedDomains).join(', '),
  )
  const [admins, setAdmins] = useState(
    (s.adminEmails.length ? s.adminEmails : state.effective.adminEmails).join(', '),
  )
  const [chatUrl, setChatUrl] = useState(s.chatUrl)
  const { busy, error, run } = useSave(props)

  return (
    <SectionForm
      testId="org-section"
      title="Your organization"
      intro="Who this workspace is for, and who can sign in."
      busy={busy}
      error={error}
      submitLabel={props.submitLabel}
      actions={props.actions}
      onSubmit={() =>
        run(() =>
          props.editor.saveSettings({
            orgName,
            productName,
            allowedDomains: domains,
            adminEmails: admins,
            chatUrl,
          }),
        )
      }
    >
      <Field label="Organization name" locked={locked.orgName}>
        {(id) => (
          <input
            id={id}
            data-testid="org-name"
            className={inputClass}
            value={orgName}
            disabled={locked.orgName}
            maxLength={80}
            placeholder="Acme Labs"
            onChange={(e) => setOrgName(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Workspace name"
        locked={locked.productName}
        hint="What your team sees in the app and browser tab, like “Acme Docs” and “Acme Meetings”. Leave it empty to keep Hotsauce."
      >
        {(id) => (
          <input
            id={id}
            data-testid="product-name"
            className={inputClass}
            value={productName}
            disabled={locked.productName}
            maxLength={40}
            placeholder="Hotsauce"
            onChange={(e) => setProductName(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Email domains that can sign in"
        locked={locked.allowedDomains}
        hint="Anyone with a Google account at one of these domains can sign in. Separate several with commas."
      >
        {(id) => (
          <input
            id={id}
            data-testid="allowed-domains"
            className={inputClass}
            value={domains}
            disabled={locked.allowedDomains}
            placeholder="acme.com"
            onChange={(e) => setDomains(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Admins"
        locked={locked.adminEmails}
        hint="Admins can change these settings later in Settings → Organization. Use your own email here."
      >
        {(id) => (
          <input
            id={id}
            data-testid="admin-emails"
            className={inputClass}
            value={admins}
            disabled={locked.adminEmails}
            placeholder="you@acme.com"
            onChange={(e) => setAdmins(e.target.value)}
          />
        )}
      </Field>
      <Field
        label="Team chat link (optional)"
        locked={locked.chatUrl}
        hint="Adds a Chat button to the app’s sidebar that opens your team chat, like a Slack or Ember link."
      >
        {(id) => (
          <input
            id={id}
            data-testid="chat-url"
            className={inputClass}
            value={chatUrl}
            disabled={locked.chatUrl}
            placeholder="https://acme.slack.com"
            onChange={(e) => setChatUrl(e.target.value)}
          />
        )}
      </Field>
    </SectionForm>
  )
}

// ── Brand ────────────────────────────────────────────────────────────────────────────────────

const NEUTRAL_LABELS = { warm: 'Warm paper', cool: 'Cool slate', gray: 'Plain gray' } as const
const THEME_LABELS = {
  system: 'Follow each person’s device',
  light: 'Light',
  dark: 'Dark',
} as const

function ColorField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  testId: string
}) {
  return (
    <Field label={label}>
      {(id) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} picker`}
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-ash-strong bg-paper-raised p-1"
          />
          <input
            id={id}
            data-testid={testId}
            className={`${inputClass} font-mono text-sm`}
            value={value}
            maxLength={7}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      )}
    </Field>
  )
}

export function BrandSection(props: SectionProps) {
  const { state, editor } = props
  const b = state.brand
  const [draft, setDraft] = useState<Brand>(b)
  const [upload, setUpload] = useState<string | null>(null)
  const { busy, error, run, setError } = useSave(props)
  const set = <K extends keyof Brand>(k: K, v: Brand[K]) => setDraft((d) => ({ ...d, [k]: v }))
  const fonts = state.fontChoices[draft.fonts]

  // Keep logo state in step with uploads, which save at once.
  useEffect(() => {
    setDraft((d) => ({ ...d, logo: b.logo, mark: b.mark }))
  }, [b.logo, b.mark])

  useEffect(() => {
    ensureFonts(fonts.display, fonts.ui)
  }, [fonts.display, fonts.ui])

  const uploadAsset = async (kind: 'logo' | 'mark', file: File | undefined) => {
    if (!file) return
    setUpload(kind)
    setError(null)
    try {
      props.onState(await editor.uploadAsset(kind, file))
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setUpload(null)
    }
  }
  const removeAsset = async (kind: 'logo' | 'mark') => {
    setError(null)
    try {
      props.onState(await editor.removeAsset(kind))
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const v = b.updatedAt ? encodeURIComponent(b.updatedAt) : '0'
  const assetUrl = (kind: 'logo' | 'mark') => (b[kind] ? `/api/org/assets/${kind}?v=${v}` : null)
  const markUrl = assetUrl('mark') ?? assetUrl('logo')
  const productName = state.settings.productName || state.effective.productName || 'Hotsauce'

  return (
    <SectionForm
      testId="brand-section"
      title="Your brand"
      intro="Your logo, colors and type, used across every app. Agents read it too, through the get_brand tool."
      busy={busy}
      error={error}
      submitLabel={props.submitLabel}
      actions={props.actions}
      onSubmit={() =>
        run(() =>
          editor.saveBrand({
            primary: draft.primary,
            accent: draft.accent,
            neutral: draft.neutral,
            fonts: draft.fonts,
            defaultTheme: draft.defaultTheme,
            voice: draft.voice,
          }),
        )
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3">
            {(['logo', 'mark'] as const).map((kind) => (
              <div key={kind} className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-ink">
                  {kind === 'logo' ? 'Logo' : 'Icon'}
                </span>
                <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-ash-strong bg-paper-sunk/50 p-2">
                  {assetUrl(kind) ? (
                    <img
                      src={assetUrl(kind) ?? ''}
                      alt=""
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-ink-faint">None yet</span>
                  )}
                </div>
                <div className="flex gap-2 text-xs">
                  <label className="cursor-pointer text-ember-strong hover:underline">
                    {upload === kind ? 'Uploading…' : assetUrl(kind) ? 'Replace' : 'Upload'}
                    <input
                      type="file"
                      data-testid={`upload-${kind}`}
                      accept="image/svg+xml,image/png,image/jpeg,image/webp"
                      className="sr-only"
                      onChange={(e) => void uploadAsset(kind, e.target.files?.[0])}
                    />
                  </label>
                  {assetUrl(kind) ? (
                    <button
                      type="button"
                      className="text-ink-faint hover:text-ink"
                      onClick={() => void removeAsset(kind)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            <p className="col-span-2 text-xs text-ink-faint">
              SVG, PNG, JPEG or WebP, up to 1 MB. The icon is the square one for the sidebar and
              browser tab; without one, the logo is used.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ColorField
              label="Main color"
              value={draft.primary}
              onChange={(x) => set('primary', x)}
              testId="brand-primary"
            />
            <ColorField
              label="Accent"
              value={draft.accent}
              onChange={(x) => set('accent', x)}
              testId="brand-accent"
            />
          </div>
          <Field label="Background">
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={draft.neutral}
                onChange={(e) => set('neutral', e.target.value as Brand['neutral'])}
              >
                {Object.entries(NEUTRAL_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Fonts">
            {(id) => (
              <select
                id={id}
                data-testid="brand-fonts"
                className={inputClass}
                value={draft.fonts}
                onChange={(e) => set('fonts', e.target.value as FontChoice)}
              >
                {Object.entries(state.fontChoices).map(([k, f]) => (
                  <option key={k} value={k}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Default look">
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={draft.defaultTheme}
                onChange={(e) => set('defaultTheme', e.target.value as Brand['defaultTheme'])}
              >
                {Object.entries(THEME_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="How your organization writes (optional)"
            hint="Guidance for AI-written meeting notes and summaries, like “Plain and short. British spelling. No jargon.”"
          >
            {(id) => (
              <textarea
                id={id}
                data-testid="brand-voice"
                rows={3}
                maxLength={2000}
                value={draft.voice}
                onChange={(e) => set('voice', e.target.value)}
                className={`${inputClass} h-auto py-2`}
              />
            )}
          </Field>
          <button
            type="button"
            className="self-start text-xs text-ink-faint hover:text-ink"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                primary: '#c63d19',
                accent: '#ee9a46',
                neutral: 'warm',
                fonts: 'classic',
                defaultTheme: 'system',
              }))
            }
          >
            Reset to the default look
          </button>
        </div>
        <BrandPreview brand={draft} markUrl={markUrl} productName={productName} fonts={fonts} />
      </div>
    </SectionForm>
  )
}

/** A small, live picture of the app in the draft brand. */
function BrandPreview({
  brand,
  markUrl,
  productName,
  fonts,
}: {
  brand: Brand
  markUrl: string | null
  productName: string
  fonts: { display: string; ui: string; label: string }
}) {
  const css = brandCss(
    {
      primary: /^#[0-9a-f]{6}$/i.test(brand.primary) ? brand.primary : '#c63d19',
      accent: /^#[0-9a-f]{6}$/i.test(brand.accent) ? brand.accent : '#ee9a46',
      neutral: brand.neutral,
      fonts: { choice: brand.fonts, ...fonts },
    },
    '.brand-preview',
  )
  return (
    <div className="lg:sticky lg:top-4 lg:self-start">
      <span className="text-sm font-medium text-ink">Preview</span>
      {css ? <style>{css}</style> : null}
      <div
        data-testid="brand-preview"
        className="brand-preview mt-1.5 overflow-hidden rounded-xl border border-ash bg-paper font-ui text-ink shadow-sm"
      >
        <div className="flex">
          <div className="flex w-11 flex-col items-center gap-3 border-r border-ash bg-paper-sunk py-3">
            {markUrl ? (
              <img src={markUrl} alt="" className="size-6 object-contain" />
            ) : (
              <HearthMark className="size-6" />
            )}
            <span className="size-5 rounded-md bg-ember-wash" />
            <span className="size-5 rounded-md bg-ash/60" />
            <span className="size-5 rounded-md bg-ash/60" />
          </div>
          <div className="min-w-0 flex-1 p-4">
            <p className="text-xs text-ink-faint">{productName} Docs</p>
            <h3 className="mt-1 font-display text-xl font-semibold tracking-tight">
              Weekly planning
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              Ship the onboarding flow by Friday.{' '}
              <span className="text-ember underline">Link to the spec</span> and the open questions
              below.
            </p>
            <div className="mt-3 flex gap-2">
              <span className="rounded-lg bg-ember px-3 py-1.5 text-xs font-medium text-paper-raised">
                Save
              </span>
              <span className="rounded-lg border border-ash-strong px-3 py-1.5 text-xs">Share</span>
              <span
                className="ml-auto size-3 self-center rounded-full"
                style={{ background: 'var(--glow)' }}
              />
            </div>
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-ink-faint">{fonts.label}</p>
    </div>
  )
}

// ── Sign-in ──────────────────────────────────────────────────────────────────────────────────

export function SignInSection(props: SectionProps) {
  const { state, editor } = props
  const [pk, setPk] = useState(state.settings.clerkPublishableKey)
  const [sk, setSk] = useState('')
  const { busy, error, run } = useSave(props)
  const { results, testing, test } = useTest(editor)
  const origin = state.effective.publicUrl || window.location.origin

  return (
    <SectionForm
      testId="signin-section"
      title="Sign-in"
      intro={
        <>
          Your team signs in with Google through <strong className="text-ink">Clerk</strong>, which
          is free for small teams. Only the email domains you chose can get in. This takes about
          five minutes.
        </>
      }
      busy={busy}
      error={error}
      submitLabel={props.submitLabel}
      actions={props.actions}
      onSubmit={() =>
        run(() =>
          editor.saveSettings({
            clerkPublishableKey: pk,
            secrets: typedSecrets({ CLERK_SECRET_KEY: sk }),
          }),
        )
      }
    >
      <ol className="flex flex-col gap-3.5">
        <StepLink n={1} href="https://dashboard.clerk.com/apps/new" cta="Create app">
          Create a Clerk application. Name it after your workspace, turn on{' '}
          <strong className="text-ink">Google</strong>, and turn off email and every other method.
        </StepLink>
        <StepLink n={2} href="https://dashboard.clerk.com/last-active?path=api-keys" cta="API keys">
          Open <strong className="text-ink">API keys</strong> and copy both keys into the fields
          below.
        </StepLink>
        <StepLink n={3} href="https://dashboard.clerk.com/last-active?path=domains" cta="Domains">
          Before your team relies on it, make a production instance for your address and follow
          Clerk’s steps for Google credentials. A development instance works for trying it out. Your
          address:
          <CopyValue value={origin} />
        </StepLink>
      </ol>
      <Field label="Publishable key" locked={state.lockedByEnv.clerkPublishableKey}>
        {(id) => (
          <input
            id={id}
            data-testid="clerk-pk"
            className={`${inputClass} font-mono text-sm`}
            value={pk}
            disabled={state.lockedByEnv.clerkPublishableKey}
            placeholder="pk_live_…"
            spellCheck={false}
            onChange={(e) => setPk(e.target.value.trim())}
          />
        )}
      </Field>
      <SecretField
        label="Secret key"
        testId="clerk-sk"
        status={state.secrets.CLERK_SECRET_KEY}
        value={sk}
        onChange={setSk}
        placeholder="sk_live_…"
        hint="Stored encrypted on this server. It is never shown again, not even to admins."
      />
      <div className="flex flex-col gap-2">
        <TestButton
          testId="test-clerk"
          busy={testing === 'clerk'}
          onClick={() => void test('clerk', sk, pk)}
        />
        <TestResult result={results.clerk ?? null} />
      </div>
    </SectionForm>
  )
}

// ── AI and transcription ─────────────────────────────────────────────────────────────────────

export function AiSection(props: SectionProps) {
  const { state, editor } = props
  const [anthropic, setAnthropic] = useState('')
  const [deepgram, setDeepgram] = useState('')
  const { busy, error, run } = useSave(props)
  const { results, testing, test } = useTest(editor)

  return (
    <SectionForm
      testId="ai-section"
      title="AI and transcription"
      intro="Bring your own keys: you pay the providers directly, usually a few dollars a month for a small team. Both are optional, and you can add them later."
      busy={busy}
      error={error}
      submitLabel={props.submitLabel}
      actions={props.actions}
      onSubmit={() =>
        run(() =>
          editor.saveSettings({
            secrets: typedSecrets({ ANTHROPIC_API_KEY: anthropic, DEEPGRAM_API_KEY: deepgram }),
          }),
        )
      }
    >
      <div className="flex flex-col gap-3 rounded-xl border border-ash p-4">
        <ol className="flex flex-col gap-3">
          <StepLink n={1} href="https://console.anthropic.com/settings/keys" cta="Anthropic keys">
            <strong className="text-ink">Anthropic</strong> writes meeting notes, summaries and chat
            answers, and cleans up dictation. Create a key and paste it below.
          </StepLink>
        </ol>
        <SecretField
          label="Anthropic API key"
          testId="anthropic-key"
          status={state.secrets.ANTHROPIC_API_KEY}
          value={anthropic}
          onChange={setAnthropic}
          placeholder="sk-ant-…"
        />
        <TestButton
          testId="test-anthropic"
          busy={testing === 'anthropic'}
          onClick={() => void test('anthropic', anthropic)}
        />
        <TestResult result={results.anthropic ?? null} />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-ash p-4">
        <ol className="flex flex-col gap-3">
          <StepLink n={2} href="https://console.deepgram.com/" cta="Deepgram console">
            <strong className="text-ink">Deepgram</strong> turns speech into text for Meetings,
            Dictate and Clips. Sign up (new accounts get free credit), open{' '}
            <strong className="text-ink">API Keys</strong>, create a key with Member access, and
            paste it below.
          </StepLink>
        </ol>
        <SecretField
          label="Deepgram API key"
          testId="deepgram-key"
          status={state.secrets.DEEPGRAM_API_KEY}
          value={deepgram}
          onChange={setDeepgram}
        />
        <TestButton
          testId="test-deepgram"
          busy={testing === 'deepgram'}
          onClick={() => void test('deepgram', deepgram)}
        />
        <TestResult result={results.deepgram ?? null} />
      </div>
      {!state.secrets.ANTHROPIC_API_KEY.set && !state.secrets.DEEPGRAM_API_KEY.set ? (
        <Callout>
          Without these keys, Docs works fully. Meetings records but can’t transcribe or write
          notes, and Dictate and Clips transcripts stay off.
        </Callout>
      ) : null}
    </SectionForm>
  )
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────

export function StorageSection(props: SectionProps) {
  const { state, editor } = props
  const s = state.settings
  const [hostKind, setHostKind] = useState(s.hostKind)
  const [githubOrg, setGithubOrg] = useState(s.githubOrg)
  const [githubToken, setGithubToken] = useState('')
  const [r2AccountId, setR2AccountId] = useState(s.r2AccountId)
  const [r2AccessKeyId, setR2AccessKeyId] = useState(s.r2AccessKeyId)
  const [r2Bucket, setR2Bucket] = useState(s.r2Bucket)
  const [r2Secret, setR2Secret] = useState('')
  const [keepAudio, setKeepAudio] = useState(s.keepAudio)
  const L = state.lockedByEnv
  // Keeping audio needs somewhere to keep it: the server refuses the save otherwise.
  const r2Ready =
    Boolean(L.r2Bucket) ||
    Boolean(
      r2AccountId &&
        r2AccessKeyId &&
        r2Bucket &&
        (r2Secret || state.secrets.R2_SECRET_ACCESS_KEY.set),
    )
  const { busy, error, run } = useSave(props)
  const { results, testing, test } = useTest(editor)
  const hostLocked = state.lockedByEnv.hostKind

  return (
    <SectionForm
      testId="storage-section"
      title="Where your files live"
      intro="Every doc and meeting note is a plain Markdown file in a git repository, so your data is always yours to take."
      busy={busy}
      error={error}
      submitLabel={props.submitLabel}
      actions={props.actions}
      onSubmit={() =>
        run(() =>
          editor.saveSettings({
            ...(hostLocked ? {} : { hostKind }),
            githubOrg,
            r2AccountId,
            r2AccessKeyId,
            r2Bucket,
            keepAudio: keepAudio && r2Ready,
            secrets: typedSecrets({ GITHUB_TOKEN: githubToken, R2_SECRET_ACCESS_KEY: r2Secret }),
          }),
        )
      }
    >
      <fieldset className="flex flex-col gap-2" disabled={hostLocked}>
        <legend className="mb-1.5 text-sm font-medium text-ink">
          Repositories
          {hostLocked ? (
            <span className="ml-2 font-normal text-ink-faint">
              (set by the server’s environment)
            </span>
          ) : null}
        </legend>
        {(
          [
            [
              'local',
              'On this server',
              'Simplest. Repositories live on the server’s disk; back the disk up.',
            ],
            [
              'github',
              'In a GitHub organization',
              'Each space is a private repository you can also open on GitHub.',
            ],
          ] as const
        ).map(([value, label, hint]) => (
          <label
            key={value}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 ${hostKind === value ? 'border-ember bg-ember-wash' : 'border-ash'}`}
          >
            <input
              type="radio"
              name="hostKind"
              data-testid={`host-${value}`}
              value={value}
              checked={hostKind === value}
              onChange={() => setHostKind(value)}
              className="mt-1 accent-[var(--ember)]"
            />
            <span>
              <span className="block text-sm font-medium text-ink">{label}</span>
              <span className="block text-xs text-ink-faint">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {hostKind === 'github' ? (
        <div className="flex flex-col gap-3 rounded-xl border border-ash p-4">
          <ol className="flex flex-col gap-3">
            <StepLink
              n={1}
              href="https://github.com/account/organizations/new?plan=free"
              cta="New org"
            >
              Use an existing GitHub organization or create a free one.
            </StepLink>
            <StepLink
              n={2}
              href="https://github.com/settings/personal-access-tokens/new"
              cta="New token"
            >
              Create a fine-grained token with your organization as the{' '}
              <strong className="text-ink">resource owner</strong>, access to all repositories, and
              these permissions set to Read and write: Administration, Contents, Webhooks.
            </StepLink>
          </ol>
          <Field label="GitHub organization" locked={L.githubOrg}>
            {(id) => (
              <input
                id={id}
                data-testid="github-org"
                className={inputClass}
                value={githubOrg}
                disabled={L.githubOrg}
                placeholder="acme-labs"
                onChange={(e) => setGithubOrg(e.target.value.trim())}
              />
            )}
          </Field>
          <SecretField
            label="GitHub token"
            testId="github-token"
            status={state.secrets.GITHUB_TOKEN}
            value={githubToken}
            onChange={setGithubToken}
            placeholder="github_pat_…"
          />
          <TestButton
            testId="test-github"
            busy={testing === 'github'}
            onClick={() => void test('github', githubToken, githubOrg)}
          />
          <TestResult result={results.github ?? null} />
        </div>
      ) : null}

      <details className="rounded-xl border border-ash p-4" open={Boolean(s.r2Bucket)}>
        <summary className="cursor-pointer text-sm font-medium text-ink">
          Meeting audio storage (optional)
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-ink-soft">
            Without this, recordings are transcribed and then dropped. With a Cloudflare R2 bucket
            (10 GB free), you can keep audio to replay later.
          </p>
          <ol className="flex flex-col gap-3">
            <StepLink
              n={1}
              href="https://dash.cloudflare.com/?to=/:account/r2/new"
              cta="New bucket"
            >
              Create an R2 bucket, for example{' '}
              <code className="font-mono text-xs">meeting-audio</code>.
            </StepLink>
            <StepLink
              n={2}
              href="https://dash.cloudflare.com/?to=/:account/r2/api-tokens"
              cta="R2 tokens"
            >
              Create an API token with Object Read &amp; Write on that bucket, and copy the account
              ID, access key ID and secret.
            </StepLink>
          </ol>
          <Field label="Account ID" locked={L.r2AccountId}>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={r2AccountId}
                disabled={L.r2AccountId}
                onChange={(e) => setR2AccountId(e.target.value.trim())}
              />
            )}
          </Field>
          <Field label="Access key ID" locked={L.r2AccessKeyId}>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={r2AccessKeyId}
                disabled={L.r2AccessKeyId}
                onChange={(e) => setR2AccessKeyId(e.target.value.trim())}
              />
            )}
          </Field>
          <SecretField
            label="Secret access key"
            status={state.secrets.R2_SECRET_ACCESS_KEY}
            value={r2Secret}
            onChange={setR2Secret}
          />
          <Field label="Bucket" locked={L.r2Bucket}>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={r2Bucket}
                disabled={L.r2Bucket}
                onChange={(e) => setR2Bucket(e.target.value.trim())}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              data-testid="keep-audio"
              checked={keepAudio && (r2Ready || Boolean(L.keepAudio))}
              disabled={Boolean(L.keepAudio) || !r2Ready}
              onChange={(e) => setKeepAudio(e.target.checked)}
              className="accent-[var(--ember)]"
            />
            Keep meeting audio after transcribing
            {!r2Ready ? <span className="text-ink-faint">(fill in R2 above first)</span> : null}
          </label>
        </div>
      </details>
    </SectionForm>
  )
}

/** What's set, in one glance: the wizard's last step and the top of Settings → Organization. */
export function Summary({ state }: { state: OrgState }) {
  const s = state.settings
  const e = state.effective
  const rows: [string, string, boolean][] = [
    ['Organization', s.orgName || e.orgName || 'Not set', Boolean(s.orgName || e.orgName)],
    ['Workspace name', s.productName || e.productName || 'Hotsauce', true],
    [
      'Who can sign in',
      (s.allowedDomains.length ? s.allowedDomains : e.allowedDomains)
        .map((d) => `@${d}`)
        .join(', ') || 'Not set',
      Boolean(s.allowedDomains.length || e.allowedDomains.length),
    ],
    [
      'Admins',
      (s.adminEmails.length ? s.adminEmails : e.adminEmails).join(', ') || 'Not set',
      Boolean(s.adminEmails.length || e.adminEmails.length),
    ],
    [
      'Sign-in (Clerk)',
      state.secrets.CLERK_SECRET_KEY.set &&
      (s.clerkPublishableKey || state.lockedByEnv.clerkPublishableKey)
        ? 'Keys saved'
        : 'Not set',
      state.secrets.CLERK_SECRET_KEY.set,
    ],
    [
      'AI (Anthropic)',
      state.secrets.ANTHROPIC_API_KEY.set ? `Key …${state.secrets.ANTHROPIC_API_KEY.last4}` : 'Off',
      state.secrets.ANTHROPIC_API_KEY.set,
    ],
    [
      'Transcription (Deepgram)',
      state.secrets.DEEPGRAM_API_KEY.set ? `Key …${state.secrets.DEEPGRAM_API_KEY.last4}` : 'Off',
      state.secrets.DEEPGRAM_API_KEY.set,
    ],
    [
      'Files',
      s.hostKind === 'github' ? `GitHub: ${s.githubOrg || 'not set'}` : 'On this server',
      true,
    ],
    [
      'Meeting audio',
      s.r2Bucket
        ? s.keepAudio
          ? `Kept in ${s.r2Bucket}`
          : `R2 ${s.r2Bucket}, not kept`
        : 'Not kept',
      true,
    ],
  ]
  return (
    <dl data-testid="org-summary" className="divide-y divide-ash/70 rounded-xl border border-ash">
      {rows.map(([k, v, ok]) => (
        <div key={k} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <dt className="w-44 shrink-0 text-ink-soft">{k}</dt>
          <dd className="min-w-0 flex-1 truncate text-ink">{v}</dd>
          <Icon
            name={ok ? 'check' : 'close'}
            className={`size-4 shrink-0 ${ok ? 'text-moss' : 'text-ink-faint'}`}
          />
        </div>
      ))}
    </dl>
  )
}
