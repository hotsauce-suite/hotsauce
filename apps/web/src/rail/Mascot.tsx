// The pepper at the foot of the left bar (docs/PLAN-rail-account-menu.md, requirement 17). It
// blinks, sleeps at night, wears sunglasses in a dark theme and hops when something gets done.
// Decoration only: nothing depends on it, and Settings → Appearance turns it off.

import { useEffect, useState } from 'react'
import { CHEER, reducedMotion, useDelight } from '../lib/delight'
import { THEME_CHOSEN } from '../lib/theme'
import { useRailTip } from './RailTip'

/** The pepper sleeps from ten at night to six in the morning, by the device's clock. */
export function asleepAt(now: Date): boolean {
  const hour = now.getHours()
  return hour >= 22 || hour < 6
}

/** What it says when the pointer rests on it. */
export function greeting(now: Date, name: string | undefined): { title: string; about: string } {
  if (asleepAt(now)) {
    return { title: 'Shh, Pepper is asleep', about: 'Still here this late? Pepper says rest soon.' }
  }
  const hour = now.getHours()
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const first = name?.trim().split(/\s+/)[0]
  return {
    title: first ? `${part}, ${first}` : part,
    about: 'Pepper hops when you finish a task or a recording.',
  }
}

/** Whether the page is showing a dark look: a dark theme, or the device's dark mode on Auto. */
function showingDark(): boolean {
  const root = document.documentElement
  const theme = root.getAttribute('data-theme')
  if (theme === 'dark' || root.getAttribute('data-scheme') === 'dark') return true
  if (theme) return false
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function useDark(): boolean {
  const [dark, setDark] = useState(showingDark)
  useEffect(() => {
    const check = () => setDark(showingDark())
    check()
    window.addEventListener(THEME_CHOSEN, check)
    let media: MediaQueryList | null = null
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)')
      media.addEventListener('change', check)
    } catch {
      media = null
    }
    return () => {
      window.removeEventListener(THEME_CHOSEN, check)
      media?.removeEventListener('change', check)
    }
  }, [])
  return dark
}

function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), everyMs)
    return () => window.clearInterval(timer)
  }, [everyMs])
  return now
}

const HOP_MS = 700

export function Mascot({ name }: { name: string | undefined }) {
  const on = useDelight()
  const dark = useDark()
  const now = useNow(5 * 60_000)
  const asleep = asleepAt(now)
  const [hop, setHop] = useState(0)
  const tip = useRailTip(greeting(now, name))

  useEffect(() => {
    if (!on) return
    // A hop is movement: none when the device asks for less. A sleeping pepper stays asleep.
    const cheer = () => {
      if (!reducedMotion() && !asleepAt(new Date())) setHop((n) => n + 1)
    }
    window.addEventListener(CHEER, cheer)
    return () => window.removeEventListener(CHEER, cheer)
  }, [on])
  useEffect(() => {
    if (hop === 0) return
    const timer = window.setTimeout(() => setHop(0), HOP_MS)
    return () => window.clearTimeout(timer)
  }, [hop])

  if (!on) return null
  return (
    <>
      <span
        aria-hidden="true"
        data-testid="rail-mascot"
        data-mood={asleep ? 'asleep' : 'awake'}
        data-shades={dark && !asleep ? '' : undefined}
        data-hop={hop > 0 ? '' : undefined}
        onPointerEnter={tip.handlers.onPointerEnter}
        onPointerLeave={tip.handlers.onPointerLeave}
        onPointerDown={() => {
          tip.handlers.onPointerDown()
          if (!reducedMotion() && !asleep) setHop((n) => n + 1)
        }}
        className="rail-mascot mb-1 grid size-9 shrink-0 place-items-center"
      >
        <svg
          key={hop}
          viewBox="0 0 48 48"
          aria-hidden="true"
          className="rail-mascot-body size-8 overflow-visible"
        >
          {/* Stem and cap */}
          <path
            d="M25 13c0-4 2-7 6-8"
            fill="none"
            stroke="var(--moss)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
          <path d="M15 15c3-4 15-4 18 0-2 3-16 3-18 0z" fill="var(--moss)" />
          {/* Body: a short, round chilli with a curled tip */}
          <path
            d="M13 17C11 25 13 33 19 39C23 43 30 46 35 43C37 41 35 39 33 40C30 40 29 38 31 35C35 30 37 23 35 17C30 20 19 20 13 17Z"
            fill="var(--ember)"
          />
          <path
            d="M16.5 22c-1 4 0 8 2.5 11.5"
            fill="none"
            stroke="var(--glow)"
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.7"
          />
          {asleep ? (
            <>
              <path
                d="M18.5 26.5q2 1.6 4 0M26.5 26.5q2 1.6 4 0"
                fill="none"
                stroke="var(--paper-raised)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <text x="35" y="14" className="rail-mascot-z" fontSize="9" fill="var(--ink-faint)">
                z
              </text>
            </>
          ) : dark ? (
            <>
              <path
                d="M16.5 24.5h7.5v3a3 3 0 0 1-3 3h-1.5a3 3 0 0 1-3-3zM25.5 24.5h7.5v3a3 3 0 0 1-3 3h-1.5a3 3 0 0 1-3-3z"
                fill="#16110e"
              />
              <path d="M16 25h17.5" stroke="#16110e" strokeWidth="1.6" strokeLinecap="round" />
            </>
          ) : (
            <g className="rail-mascot-eyes" fill="var(--paper-raised)">
              <ellipse cx="20.5" cy="26" rx="2" ry="2.4" />
              <ellipse cx="28.5" cy="26" rx="2" ry="2.4" />
            </g>
          )}
          {asleep ? null : (
            <path
              d="M21.5 31.5q3 2.4 6 0"
              fill="none"
              stroke="var(--paper-raised)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          )}
        </svg>
      </span>
      {tip.node}
    </>
  )
}
