# Today's sky

## Status
R1 to R8 shipped in 0.56.0 (2026-11-19, #199); Morgan said yes to every recommendation. R9
("Follow the sun") follows in its own PR, after the account menu's light/dark switch (#197).

## What
A band behind Today's greeting whose sky follows the time of day and the member's theme, with the
sun at its true place along its arc, or after dark the moon in its real phase, plus a line with
sunrise, sunset and the length of the day. Web and the Mac app (the app shows the same page).

## Requirements
- **R1** Three looks, per device: Sky (default), Sun path, Off. Picked in Edit Today and in
  Settings → Appearance → Today's sky; it applies at once. Off leaves Today as it was.
  Tests: `sky/TodaySky.test.tsx` (on Today).
- **R2** Sky colours for dawn, day, dusk and night, mixed into the theme's paper so text keeps its
  contrast and any theme (light, dark, a member's own) gets a matching sky. The sun sits at its
  real position between sunrise and sunset; at night the moon crosses from sunset to sunrise in
  its real phase, with a few stars. Tests: `sky/TodaySky.test.tsx`, `sky/sunMoon.test.ts`.
- **R3** Under the greeting: "Sunrise 6:52 AM · Sunset 4:21 PM · 9h 29m of daylight"; after
  sunset "Sunset was … · Sunrise tomorrow …"; the midnight sun and polar night say so. Hovering
  the sun or moon shows the same, or the moon's phase and how much is lit.
  Tests: `sky/TodaySky.test.tsx`.
- **R4** The place is the device's weather place, else the team's place; hiding the weather
  doesn't hide the sun. With neither, the sky follows the clock and offers "Set your place".
  Never asks for the location itself. Tests: `sky/TodaySky.test.tsx`.
- **R5** The weather the header shows appears lightly: clouds, rain, snow, fog. Nothing extra is
  fetched. Tests: `sky/TodaySky.test.tsx`.
- **R6** Sunrise and sunset within 3 minutes of published times; the moon's phase within a day.
  Worked out on the device, no service, no key. Tests: `sky/sunMoon.test.ts` (with fast-check).
- **R7** Slow and calm; with "reduce motion" on it is a still picture (no drift, rain or
  twinkle). Browsers already pause it in a background tab or hidden Mac app window.
- **R9** Follow the sun: a look in the account menu ("Sun") and Settings → Appearance ("Follow the
  sun") that is light from sunrise to sunset and dark otherwise, at the same place as the sky
  (the team's place is remembered on the device once Today has fetched it; without a place,
  light from 7:00 to 17:00). Checked each minute and on waking; the last answer is kept so the
  first paint matches. Tests: `sky/followSun.test.ts`, `components/AppRail.test.tsx`.
- **R8** On phones the sun and moon travel in a strip above the greeting, never behind the words.

## Pieces
- `apps/web/src/apps/today/sky/sunMoon.ts`: the almanac maths.
- `apps/web/src/apps/today/sky/followSun.ts` and `lib/theme.ts` (`sun`): Follow the sun.
- `apps/web/src/apps/today/sky/skyState.ts`: the scene choice, the place, the header's weather.
- `apps/web/src/apps/today/sky/TodaySky.tsx`, `SkyScenePicker.tsx`, `styles/sky.css`.
