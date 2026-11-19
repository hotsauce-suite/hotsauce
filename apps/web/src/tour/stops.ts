// The first-run tour's stops (docs/PLAN-tour-and-101.md T2, T4): one list, in order, each pointing
// at a control by its test id. The welcome card (stop 1) is the tour's own pop-up, not in here.

export interface TourContext {
  /** The workspace's name ("Acme"), or the product's when it has none. */
  name: string
  /** Inside the Mac app: Dictate is a key away, and Settings has This Mac. */
  mac: boolean
}

export interface TourStop {
  id: string
  /** The control's `data-testid`; null for a stop in the middle of the screen. */
  target: string | null
  title: string
  body: string
}

/** Every stop after the welcome, in order. A stop whose control isn't on screen is left out. */
export function tourStops({ name, mac }: TourContext): TourStop[] {
  return [
    {
      id: 'rail',
      target: 'app-rail',
      title: 'Your apps',
      body: 'The apps you use most sit here. Click one to switch; each opens where you left it. Hover any of them for what it does.',
    },
    {
      id: 'today',
      target: 'today-greeting',
      title: 'Today is your home page',
      body: 'Your next meeting, what’s due and the weather, ready every time you open it.',
    },
    {
      id: 'edit-today',
      target: 'today-edit',
      title: 'Make Today yours',
      body: 'Add, move and remove tiles. Your layout follows you to every device.',
    },
    {
      id: 'launcher',
      target: 'launcher-button',
      title: 'Every app, and your pins',
      body: 'See every app here. The pencil lets you pin the ones you use to the rail.',
    },
    {
      id: 'search',
      target: null,
      title: 'Find anything with ⌘K',
      body: 'Search every doc, meeting and task, or run a command. Press ? for every keyboard shortcut.',
    },
    {
      id: 'ask',
      target: 'assistant-open',
      title: `Ask ${name}`,
      body: 'Ask about anything in your workspace, like “prep me for my next meeting”. ⌘J opens it on any page.',
    },
    {
      id: 'meetings',
      target: 'app-switch-meetings',
      title: 'Meeting notes without a bot',
      body: 'Record a call here and get clean notes afterwards. No bot joins your call.',
    },
    mac
      ? {
          id: 'dictate',
          target: null,
          title: 'Dictate anywhere',
          body: 'Hold the right Option key in any app, talk, and let go. Your words land where your cursor is.',
        }
      : {
          id: 'dictate',
          target: null,
          title: 'Dictate anywhere',
          body: 'Get the Mac app to dictate into any app: hold a key, talk, let go.',
        },
    {
      id: 'for-you',
      target: 'today-for-you',
      title: 'When someone @mentions you',
      body: 'Comments that mention you wait here until you mark them Done.',
    },
    {
      id: 'rail-names',
      target: 'rail-toggle',
      title: 'Show the names',
      body: 'Click the logo to widen the rail so every app shows its name.',
    },
    {
      id: 'menu',
      target: 'account-menu',
      title: 'Your menu',
      body: `Settings, music, light or dark, shortcuts and help live here, and “Take the tour” too. Settings → Hotsauce 101 shows what every app is for.${
        mac ? ' This Mac has its own page in Settings.' : ''
      }`,
    },
    {
      id: 'start',
      target: 'today-start',
      title: 'Three things worth doing first',
      body: 'Connect your calendar so Today fills up, then work down this list.',
    },
  ]
}

/** The stops whose control is on screen now; middle-of-screen stops always stay. */
export function presentStops(
  stops: readonly TourStop[],
  find: (testId: string) => Element | null,
): TourStop[] {
  return stops.filter((stop) => stop.target === null || find(stop.target) !== null)
}

/** The first visible element with this test id (the rail is drawn twice: rail and phone bar). */
export function findByTestId(testId: string, root: ParentNode = document): Element | null {
  for (const el of root.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`)) {
    if (el.getClientRects().length > 0) return el
  }
  return null
}
