import { useLayoutEffect, useRef } from 'react'
import type { FilledValue, SignField } from '../../api/sign'
import { Icon } from '../../components/Icon'
import { FIELD_LABEL } from './fields'

/** Today on this device's calendar, as YYYY-MM-DD. */
export function localDay(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Focuses a placed field's button once it is on the page, so the keyboard moves it. */
export function focusField(id: string) {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-field-focus="${CSS.escape(id)}"]`)?.focus()
  })
}

/** One field on a page: a box to drag in a draft, or something to fill in while signing. */
export function FieldBox({
  field,
  editable,
  selected,
  signable,
  value,
  onSelect,
  onMove,
  onResize,
  onRemove,
  onFill,
  onText,
  owner,
}: {
  /** Whose field it is, shown when more than one person signs. */
  owner?: string | undefined
  field: SignField
  editable: boolean
  selected: boolean
  signable: boolean
  value: FilledValue | undefined
  onSelect: () => void
  onMove: (dx: number, dy: number) => void
  onResize: (dw: number, dh: number) => void
  onRemove: () => void
  onFill: () => void
  onText: (text: string) => void
}) {
  const label = owner ? `${FIELD_LABEL[field.type]} · ${owner}` : FIELD_LABEL[field.type]
  const style = {
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    width: `${field.width * 100}%`,
    height: `${field.height * 100}%`,
  }
  const drag = (kind: 'move' | 'resize') => (e: React.PointerEvent<HTMLElement>) => {
    if (!editable) return
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    // preventDefault stops the browser focusing it, so the arrow keys would do nothing.
    focusField(field.id)
    const page = (
      e.currentTarget.closest('[data-testid^="sign-page-"]') as HTMLElement | null
    )?.getBoundingClientRect()
    if (!page) return
    let last = { x: e.clientX, y: e.clientY }
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - last.x) / page.width
      const dy = (ev.clientY - last.y) / page.height
      last = { x: ev.clientX, y: ev.clientY }
      if (kind === 'move') onMove(dx, dy)
      else onResize(dx, dy)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (signable) {
    if (field.type === 'text') {
      return (
        <input
          className="absolute rounded-sm bg-ember-wash/70 px-1 text-[clamp(8px,1.4vw,14px)] text-ink outline-none ring-2 ring-ember focus:bg-white"
          style={style}
          value={value?.value ?? ''}
          maxLength={5000}
          placeholder="Type here"
          aria-label="Text field"
          onChange={(e) => onText(e.target.value)}
          data-testid={`sign-field-${field.id}`}
        />
      )
    }
    if (field.type === 'date') {
      return (
        <span
          className="absolute flex items-center rounded-sm bg-paper-sunk/80 px-1 text-[clamp(8px,1.4vw,14px)] text-ink-soft ring-1 ring-ash-strong"
          style={style}
          data-testid={`sign-field-${field.id}`}
        >
          {localDay()}
        </span>
      )
    }
    const filled =
      field.type === 'checkbox' ? value?.checked : Boolean(value?.value || value?.image)
    return (
      <button
        type="button"
        className={`absolute flex items-center justify-center overflow-hidden rounded-sm text-[clamp(8px,1.4vw,14px)] ring-2 ${filled ? 'bg-white/80 ring-ash-strong' : 'animate-pulse bg-ember-wash/80 ring-ember'}`}
        style={style}
        onClick={onFill}
        aria-label={`${FIELD_LABEL[field.type]}${filled ? ', filled' : ''}`}
        data-testid={`sign-field-${field.id}`}
      >
        {field.type === 'checkbox' ? (
          value?.checked ? (
            <Icon name="check" className="size-full" />
          ) : null
        ) : value?.image ? (
          <img src={value.image} alt="" className="size-full object-contain" />
        ) : value?.value ? (
          <FitScript text={value.value} />
        ) : (
          <span className="font-medium text-ink">{FIELD_LABEL[field.type]}</span>
        )}
      </button>
    )
  }

  return (
    <div
      className={`absolute flex select-none items-center justify-center rounded-sm border text-[clamp(7px,1.2vw,12px)] ${editable ? 'cursor-move touch-none' : ''} ${selected ? 'border-ember bg-ember-wash/80 text-ink' : 'border-ember/60 bg-ember-wash/50 text-ink-soft'}`}
      style={style}
      onPointerDown={drag('move')}
      data-testid={`sign-field-${field.id}`}
      data-field-type={field.type}
    >
      {editable ? (
        <button
          type="button"
          className="size-full cursor-move truncate px-1 outline-none focus-visible:ring-2 focus-visible:ring-ember"
          onFocus={onSelect}
          data-field-focus={field.id}
          aria-label={`${FIELD_LABEL[field.type]} field${owner ? ` for ${owner}` : ''} on page ${field.page}`}
        >
          {label}
        </button>
      ) : (
        <span className="truncate px-1">{label}</span>
      )}
      {editable && selected ? (
        <>
          <button
            type="button"
            className="absolute -top-3 -right-3 flex size-6 items-center justify-center rounded-full bg-ink text-paper-raised"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onRemove}
            aria-label={`Remove ${FIELD_LABEL[field.type]}`}
            data-testid="sign-field-remove"
          >
            <Icon name="close" className="size-3" />
          </button>
          <span
            className="absolute right-0 bottom-0 size-3 cursor-se-resize bg-ember"
            onPointerDown={drag('resize')}
            aria-hidden="true"
          />
        </>
      ) : null}
    </div>
  )
}

/** A typed signature as big as its field allows, shrinking to fit, as on the signed PDF. */
function FitScript({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit when the text changes
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.parentElement
    if (!el || !box) return
    const fit = () => {
      let size = box.clientHeight * 0.62
      el.style.fontSize = `${size}px`
      while (size > 6 && el.offsetWidth > box.clientWidth - 6) {
        size *= 0.9
        el.style.fontSize = `${size}px`
      }
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [text])
  return (
    <span ref={ref} className="sign-script inline-block whitespace-nowrap px-1 leading-none">
      {text}
    </span>
  )
}
