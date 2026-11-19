# Hot sauce Easter eggs

## Status

Building (2026-11-19). Morgan accepted every recommendation (thread "Hide hot sauce Easter eggs in
Hotsauce"): six eggs, a sizzle only when sounds are on, a hidden Mac menu item, undocumented except
one FAQ joke. They stay off the left rail, its pepper mascot, the logo and the account menu, which
belong to docs/PLAN-rail-account-menu.md.

## Rules for every egg

- Harmless and quick: nothing saves, nothing blocks a click, nothing lasts more than ~2 s.
- Reduced motion: no falling or flying; a still, quiet version instead.
- Sound only if the member already turned on sounds (Settings → Appearance, the tool-switch tick),
  and never while anything records.
- Plain code in `apps/web/src/eggs/`, so they are easy to find and easy to remove.

## Requirements

- **E1** Konami code (↑ ↑ ↓ ↓ ← → ← → B A), typed anywhere but a text field, starts a ~2 s shower
  of chili peppers that ignores the pointer and removes itself. Reduced motion shows a still 🌶
  badge instead.
- **E2** The shower plays a soft sizzle when sounds are on and nothing records.
- **E3** In ⌘K, typing exactly "more heat" (or "ghost pepper") offers **More heat**, which turns on
  the hidden Ghost Pepper theme and remembers the look before it. "less heat" offers **Less heat**,
  which puts that look back. Neither shows for any other query, nor in the empty menu.
- **E4** Appearance never drops Ghost Pepper as a "deleted theme"; it says Ghost Pepper is on and
  how to cool down. Picking any look turns it off.
- **E5** Completing a task whose title has 🌶 or "hot sauce" (any case) bursts a few peppers from
  where the member clicked, in Tasks and on Today. Reduced motion: no burst.
- **E6** An address no page owns shows the lost-sauce page inside the app ("This page got too spicy
  and left.") with a button to Docs, instead of jumping to Docs silently.
- **E7** On January 22 (the device's date) Today shows "Happy National Hot Sauce Day 🌶" under the
  greeting; never on any other day.
- **E8** The browser console shows a small pepper and "Hotsauce is open source, come add some heat"
  with the GitHub link, once per page load.
- **E9** Mac app: holding Option on the Hotsauce menu turns "About Hotsauce" into
  "Add more heat 🌶", which brings the window forward and starts the shower (E1).
- **E10** hotsauce.work FAQ: "Are there Easter eggs?" "We'd never."

## Slices

1. Pure logic (Konami tracker, spicy titles, the date, ⌘K secret matching, Ghost Pepper contrast):
   unit tests.
2. Web wiring (shower, burst, commands, 404, Today, console): component tests, one e2e.
3. Mac menu item (Swift), FAQ line, learnings.
