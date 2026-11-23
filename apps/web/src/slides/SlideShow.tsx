// Presenting a Doc as slides (docs/PLAN-slides.md). Two layouts: the slides filling the screen,
// or presenter view (this slide, the next, the notes, a timer) driving a second window that shows
// the slides. Both windows render from this one component, so nothing needs syncing.

import { type Slide, splitSlides } from '@hotsauce/format'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../components/Icon'
import { type Audience, openAudience } from './audienceWindow'
import { macDisplays, macFullScreen } from './mac'
import { type Point, SlideFrame, SlideMarkdown, type SlideSource } from './SlideFrame'
import { elapsedLabel, onKey, type ShowMode, type ShowState, startShow } from './showState'

export type StartMode = ShowMode | 'auto'

export interface SlideShowProps extends SlideSource {
  /** The doc's text when the show started. */
  markdown: string
  title: string
  start?: StartMode
  onClose: () => void
}

/** Presenter view by itself when there is a second screen to show the slides on (R6, R11). */
export function pickMode(start: StartMode): ShowMode {
  if (start !== 'auto') return start
  const mac = macDisplays()
  if (mac !== null) return mac > 1 ? 'presenter' : 'slides'
  const screen = window.screen as Screen & { isExtended?: boolean }
  return screen.isExtended === true ? 'presenter' : 'slides'
}

export default function SlideShow({
  markdown,
  title,
  start = 'auto',
  onClose,
  ...source
}: SlideShowProps) {
  const slides = useMemo<Slide[]>(() => {
    const split = splitSlides(markdown)
    return split.length > 0 ? split : [{ body: `# ${title}`, notes: '' }]
  }, [markdown, title])
  const [show, setShow] = useState<ShowState>(() => startShow(slides.length, pickMode(start)))
  const [laser, setLaser] = useState<Point | null>(null)
  const [audience, setAudience] = useState<Audience | null>(null)
  const [blocked, setBlocked] = useState(false)
  const timer = useTimer()
  const onMac = macDisplays() !== null

  const close = useRef(onClose)
  close.current = onClose

  // Full screen for the slides layout in this window: the Mac app's own, or the browser's.
  const fullscreen = useRef<'mac' | 'browser' | null>(null)
  const enterFullScreen = useCallback(() => {
    if (fullscreen.current) return
    if (macFullScreen(true)) fullscreen.current = 'mac'
    else if (document.documentElement.requestFullscreen) {
      fullscreen.current = 'browser'
      document.documentElement.requestFullscreen().catch(() => {
        fullscreen.current = null
      })
    }
  }, [])
  const leaveFullScreen = useCallback(() => {
    if (fullscreen.current === 'mac') macFullScreen(false)
    if (fullscreen.current === 'browser' && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    }
    fullscreen.current = null
  }, [])

  // The browser leaving full screen (its own Esc) ends the show, as a second Esc would.
  useEffect(() => {
    const changed = () => {
      if (fullscreen.current === 'browser' && !document.fullscreenElement) {
        fullscreen.current = null
        close.current()
      }
    }
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])

  // The layout decides the windows: slides full screen here, or presenter here and slides there.
  const mode = show.mode
  useEffect(() => {
    if (mode === 'slides') {
      enterFullScreen()
      return
    }
    leaveFullScreen()
  }, [mode, enterFullScreen, leaveFullScreen])

  const openSlidesWindow = useCallback(() => {
    const opened = openAudience(title)
    setBlocked(opened === null)
    setAudience(opened)
  }, [title])
  useEffect(() => {
    if (mode !== 'presenter') return
    openSlidesWindow()
  }, [mode, openSlidesWindow])
  // The switch back to slides here closes it; the audience closing it ends the show (R11).
  useEffect(() => {
    if (!audience) return
    if (mode !== 'presenter') {
      audience.win.close()
      setAudience(null)
      return
    }
    const watch = setInterval(() => {
      if (audience.win.closed) close.current()
    }, 500)
    return () => clearInterval(watch)
  }, [audience, mode])
  // Leaving the show closes everything it opened.
  const audienceRef = useRef(audience)
  audienceRef.current = audience
  useEffect(
    () => () => {
      audienceRef.current?.win.close()
      leaveFullScreen()
    },
    [leaveFullScreen],
  )

  // The show takes the keyboard: the editor behind it must not get a single keystroke (R5).
  const stage = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    stage.current?.focus({ preventScroll: true })
  }, [])

  const showRef = useRef(show)
  showRef.current = show
  const press = useCallback(
    (key: string) => {
      const result = onKey(showRef.current, key)
      showRef.current = result.state
      setShow(result.state)
      if (result.effect === 'close') close.current()
      if (result.effect === 'fullscreen') {
        const other = audienceRef.current
        if (other) toggleFullScreen(other.win.document)
        // Here, through our own switch, so leaving full screen with F doesn't end the show.
        else if (fullscreen.current || document.fullscreenElement) leaveFullScreen()
        else enterFullScreen()
      }
      return result.handled
    },
    [enterFullScreen, leaveFullScreen],
  )
  // Keys in this window and in the slides window both drive the show.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        // ⌘K would open the palette behind the show, where it swallows every key.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      const target = elementOf(event.target)
      const inShow =
        target !== null && (stage.current?.contains(target) || target.ownerDocument !== document)
      if (press(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      // Tab still moves between the presenter's buttons; nothing else reaches the doc behind.
      if (event.key === 'Tab' && inShow) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    const other = audience?.win
    other?.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      other?.removeEventListener('keydown', onKeyDown, true)
    }
  }, [press, audience])

  useEffect(() => {
    if (!show.laser) setLaser(null)
  }, [show.laser])

  const current = slides[show.index] as Slide
  const upcoming = slides[show.index + 1] ?? null
  const total = slides.length
  const advance = (event: { target: EventTarget | null; preventDefault: () => void }) => {
    // A link on the slide opens in a new tab, so neither window leaves the show; anywhere else,
    // the next slide.
    const link = elementOf(event.target)?.closest('a')
    if (link) {
      event.preventDefault()
      if (link.href) window.open(link.href, '_blank', 'noopener')
      return
    }
    press('ArrowRight')
  }

  const big = (testId: string, pointer: boolean) => (
    <SlideFrame
      slide={current}
      number={show.index + 1}
      total={total}
      source={source}
      laser={show.laser ? laser : null}
      onPoint={show.laser && pointer ? setLaser : undefined}
      testId={testId}
    />
  )

  const slidesLayout = (pointer: boolean, testId: string, hint: ReactNode = null) => (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the show's keys are on the window
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the slide goes on
    <div className="slides-stage relative h-full w-full p-[1vmin]" onClick={advance}>
      {show.black ? (
        <div className="absolute inset-0 z-10 bg-[#141110]" data-testid="slides-black" />
      ) : null}
      {big(testId, pointer)}
      {hint}
    </div>
  )

  const here =
    mode === 'slides' ? (
      slidesLayout(true, 'slide')
    ) : (
      <PresenterView
        show={show}
        current={big('presenter-slide', true)}
        upcoming={
          upcoming ? (
            <SlideFrame slide={upcoming} number={show.index + 2} total={total} source={source} />
          ) : null
        }
        notes={current.notes}
        source={source}
        timer={timer}
        slidesWindow={audience ? 'open' : blocked ? 'blocked' : 'closed'}
        onMac={onMac}
        press={(key) => void press(key)}
        onOpenSlidesWindow={openSlidesWindow}
        onClose={() => close.current()}
      />
    )

  return (
    <>
      {createPortal(
        <div
          ref={stage}
          tabIndex={-1}
          className="fixed inset-0 z-[90] outline-none"
          data-testid="slide-show"
          data-mode={mode}
          role="dialog"
          aria-modal="true"
          aria-label={`Presenting ${title}`}
        >
          {here}
        </div>,
        document.body,
      )}
      {audience
        ? createPortal(
            slidesLayout(
              false,
              'audience-slide',
              onMac ? null : <FullScreenHint win={audience.win} />,
            ),
            audience.root,
          )
        : null}
    </>
  )
}

/** F in presenter view: full screen for the slides window. */
function toggleFullScreen(doc: Document) {
  if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {})
  else void doc.documentElement.requestFullscreen?.().catch(() => {})
}

/** The element an event came from, in either window (`instanceof` fails across windows). */
function elementOf(target: EventTarget | null): Element | null {
  const node = target as Node | null
  return node && node.nodeType === 1 ? (node as Element) : null
}

/** A browser can't move a window to the projector itself: say how, then get out of the way. */
function FullScreenHint({ win }: { win: Window }) {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setShown(false), 8000)
    const full = () => setShown(false)
    win.document.addEventListener('fullscreenchange', full)
    return () => {
      clearTimeout(t)
      win.document.removeEventListener('fullscreenchange', full)
    }
  }, [win])
  if (!shown) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
      <p className="rounded-full bg-[#141110]/85 px-4 py-2 text-sm text-[#ede3d6]">
        Drag this window to the projector, then press F for full screen.
      </p>
    </div>
  )
}

interface Timer {
  elapsed: number
  running: boolean
  toggle: () => void
  reset: () => void
}

/** The talk's clock: starts with the show, can be paused and reset. */
function useTimer(): Timer {
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const now = Date.now()
  return {
    elapsed: (pausedAt ?? now) - startedAt,
    running: pausedAt === null,
    toggle: () => {
      if (pausedAt === null) setPausedAt(Date.now())
      else {
        setStartedAt((s) => s + (Date.now() - pausedAt))
        setPausedAt(null)
      }
    },
    reset: () => {
      setStartedAt(Date.now())
      setPausedAt((p) => (p === null ? null : Date.now()))
    },
  }
}

function StageButton({
  icon,
  label,
  onClick,
  pressed,
  testId,
  children,
}: {
  icon: IconName
  label: string
  onClick: () => void
  pressed?: boolean
  testId?: string
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={children ? undefined : label}
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors ${
        pressed ? 'bg-white/15 text-white' : 'text-[#c1b2a2] hover:bg-white/10 hover:text-white'
      }`}
    >
      <Icon name={icon} className="size-4" />
      {children}
    </button>
  )
}

function PresenterView({
  show,
  current,
  upcoming,
  notes,
  source,
  timer,
  slidesWindow,
  onMac,
  press,
  onOpenSlidesWindow,
  onClose,
}: {
  show: ShowState
  current: ReactNode
  upcoming: ReactNode
  notes: string
  source: SlideSource
  timer: Timer
  slidesWindow: 'open' | 'blocked' | 'closed'
  onMac: boolean
  press: (key: string) => void
  onOpenSlidesWindow: () => void
  onClose: () => void
}) {
  const clock = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="slides-stage flex h-full flex-col" data-testid="presenter-view">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
        <span className="text-sm text-[#c1b2a2] tabular-nums" data-testid="presenter-count">
          Slide {show.index + 1} of {show.total}
        </span>
        <span className="mx-2 h-5 w-px bg-white/15" aria-hidden="true" />
        <span
          className="font-display text-2xl tabular-nums text-white"
          data-testid="presenter-timer"
          title="Time presenting"
        >
          {elapsedLabel(timer.elapsed)}
        </span>
        <StageButton
          icon={timer.running ? 'pause' : 'play'}
          label={timer.running ? 'Pause the timer' : 'Start the timer'}
          onClick={timer.toggle}
          testId="presenter-timer-toggle"
        />
        <StageButton icon="history" label="Reset the timer" onClick={timer.reset} />
        <span className="ml-2 text-sm text-[#c1b2a2] tabular-nums" title="Time now">
          {clock}
        </span>
        <div className="flex-1" />
        {slidesWindow !== 'open' ? (
          <StageButton
            icon="share"
            label="Open the slides window"
            onClick={onOpenSlidesWindow}
            testId="open-slides-window"
          >
            {slidesWindow === 'blocked'
              ? onMac
                ? 'The slides window didn’t open. Open it here'
                : 'Allow pop-ups, then open the slides window'
              : 'Open the slides window'}
          </StageButton>
        ) : null}
        <StageButton
          icon="sparkle"
          label="Laser pointer (L)"
          pressed={show.laser}
          onClick={() => press('l')}
          testId="presenter-laser"
        >
          Laser
        </StageButton>
        <StageButton icon="eyeOff" label="Black out the screen (B)" onClick={() => press('b')}>
          Black
        </StageButton>
        <StageButton icon="play" label="Slides only (P)" onClick={() => press('p')}>
          Slides only
        </StageButton>
        <StageButton icon="close" label="End the show (Esc)" onClick={onClose} testId="end-show">
          End
        </StageButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
        <div className="relative min-h-0 flex-[3]">
          {current}
          {show.black ? (
            <p className="absolute inset-x-0 top-2 text-center text-xs text-[#c1b2a2]">
              The audience sees a black screen. Press any key to bring it back.
            </p>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-[2] flex-col gap-4">
          <div className="h-[28vh] shrink-0">
            <p className="mb-1 text-xs tracking-wide text-[#8d7d6f] uppercase">Next</p>
            <div className="h-[calc(100%-1.25rem)]">
              {upcoming ?? (
                <div className="flex h-full items-center justify-center rounded-lg border border-white/10 text-sm text-[#8d7d6f]">
                  End of the deck
                </div>
              )}
            </div>
          </div>
          <section
            className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-white/5 p-4"
            data-testid="slide-notes"
            aria-label="Speaker notes"
          >
            {notes ? (
              <SlideMarkdown {...source} markdown={notes} className="slide-notes-prose" />
            ) : (
              <p className="text-sm text-[#8d7d6f]">
                No notes for this slide. Add a line starting “Notes:” at the end of a slide.
              </p>
            )}
          </section>
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-white/10 py-2">
        <StageButton icon="back" label="Previous slide" onClick={() => press('ArrowLeft')} />
        <StageButton icon="forward" label="Next slide" onClick={() => press('ArrowRight')} />
        {onMac ? null : (
          <span className="ml-4 hidden text-xs text-[#8d7d6f] md:inline">
            ← → to move · L laser · B black · P slides only · Esc to end
          </span>
        )}
      </footer>
    </div>
  )
}
