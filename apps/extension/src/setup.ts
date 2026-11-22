// What the setup page shows (docs/PLAN-extension-setup.md): three first steps, each ticked from
// what is really so, and the settings below them. Pure, so it's tested without Chrome.

import type { Server } from './server'

export const HELP_URL = 'https://hotsauce.work/help/chrome-extension'
/** Opens a new Google Meet call: the test call. Nothing records unless the person starts it. */
export const TEST_CALL_URL = 'https://meet.google.com/new'
/** Chrome's own screen for changing an extension's keyboard shortcuts. */
export const SHORTCUTS_URL = 'chrome://extensions/shortcuts'
/** Set by the popup the first time it shows Take notes on a call: the test call worked. */
export const TRIED_KEY = 'tried-meet'

export type StepId = 'connect' | 'pin' | 'try'

export interface Step {
  id: StepId
  title: string
  hint: string
  done: boolean
}

export interface SetupFacts {
  server: Server | null
  /** Whether Chrome shows the icon on the toolbar; null when Chrome can't say. */
  pinned: boolean | null
  /** Whether the popup has shown Take notes on a Meet call. */
  tried: boolean
}

export function steps(facts: SetupFacts, name: string): Step[] {
  return [
    {
      id: 'connect',
      title: 'Connect to your workspace',
      hint: facts.server
        ? `Connected to ${new URL(facts.server.url).host}.`
        : `Enter the address you use for ${name}, like hotsauce.acme.com.`,
      done: facts.server !== null,
    },
    {
      id: 'pin',
      title: 'Pin the icon',
      hint:
        facts.pinned === true
          ? `The ${name} icon is on Chrome’s toolbar.`
          : `Click the puzzle piece at the top right of Chrome, then the pin next to ${name}.`,
      done: facts.pinned === true,
    },
    {
      id: 'try',
      title: 'Try it on a Meet call',
      hint: facts.tried
        ? 'It works. On your next call, click the icon and choose Take notes.'
        : 'Start a test call, then click the icon: you’ll see Take notes. Nothing records until you start it.',
      done: facts.tried,
    },
  ]
}

/** The shortcut Chrome has for opening the popup, or null when none is set. */
export function shortcutFor(commands: { name?: string; shortcut?: string }[]): string | null {
  const open = commands.find((c) => c.name === '_execute_action')
  const keys = open?.shortcut?.trim()
  return keys ? keys : null
}

/**
 * How this copy gets updates. Chrome's install type says Web Store ("normal", or "admin" when the
 * organization installs it) or by hand ("development", Load unpacked).
 */
export function updateNote(installType: string | undefined, server: Server | null): string {
  if (installType === 'normal' || installType === 'admin') {
    return 'From the Chrome Web Store: Chrome updates it by itself.'
  }
  const where = server ? `${new URL(server.url).host}/meetings/extension` : 'your workspace'
  return `Installed by hand: get a new copy from ${where}, replace the folder’s contents, then click reload on chrome://extensions.`
}

/** Only a fresh install opens the setup page; updates and reloads stay quiet. */
export function opensSetup(reason: string): boolean {
  return reason === 'install'
}
