# Learnings: dates and weeks

From making every week start on Monday (`docs/PLAN-monday-weeks.md`, 2026-11-13).

- **The browser's date picker can't be told which day starts the week.** `<input type="date">`
  follows the computer's region (Sunday first in the US), with no attribute to change it. Anywhere
  the week start matters, use `components/DatePicker.tsx` instead.
- **Most of the app was already Monday-first.** Today's This week tile, Check-ins' day order,
  repeat labels and backup weeks all did `(getDay() + 6) % 7` on their own. The shared helpers are
  now `startOfWeek`, `endOfWeek` and `monthGrid` in `packages/format/src/weeks.ts`; reach for those
  rather than writing the offset again.
- **Keep date-only values as `YYYY-MM-DD` strings and do the math in UTC.** A local `Date` at
  midnight moves a day across a DST change or a time zone; the format package's `addDays` works on
  UTC midnights so it can't. Pages that really mean "local midnight" (the booking page) use
  `setDate`, which is DST-safe too.
- **A popover in a portal needs its own focus rules.** Moving focus to a day after a month-button
  click strands keyboard users; only arrow keys and opening should move it. Close on focus-out,
  scroll and resize, and swallow the click after an outside tap, or that tap also presses whatever
  is under it (the task sheet's backdrop closed the whole task).
- **A button's `aria-label` overrides the page's `<label for>`.** On forms, let the label name the
  button (it carries the required marker) and point `aria-describedby` at the chosen date.
- **Week-aligned views need a plan for the end of the week.** On a Sunday evening the booking page's
  current week has nothing left, so it opens on next week, but only after checking next week has
  times; otherwise a short booking horizon would land people on an empty week.
- **Tests that depend on today must hold on every weekday.** Pick fixed dates where you can (pass
  `today` to the picker), and where the real clock is in play, assert "this week or next" and
  compare against the real next Monday rather than a fixed number of hours.
- **The Mac app's Swift tests need full Xcode.** With only the Command Line Tools, `swift build`
  works but `swift test` can't load the Testing macros. Check logic in a small `swift` script.
