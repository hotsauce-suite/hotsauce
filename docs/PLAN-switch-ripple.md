# Tool-switch ripple

Status: built 2026-11-19 (Morgan's ask in the project chat: "mild, fast animation every time the user changes to a new tool... a ripple effect... maybe with a light sound").

Opening another tool plays a short ripple from the click, and, if the member chooses, a soft tick.
Web and the Mac app (which shows the same pages in its web view).

## Requirements

- **R1** When the open tool changes (rail, phone tab bar, launcher, ⌘K, `g` shortcuts, links), a ripple plays. Not on the first page shown, not when moving within one tool, not when going to Settings. Test: `useSwitchFx.test.tsx`.
- **R2** The ripple starts at the click that switched tools, else at that tool's rail icon; it lasts about 0.4 s, sits above the page, ignores the pointer and removes itself. Test: `switchFx.test.ts`, `useSwitchFx.test.tsx`.
- **R3** No ripple when the device asks for reduced motion, whatever the switch says. Test: `switchFx.test.ts` (property), `useSwitchFx.test.tsx`.
- **R4** The sound is off by default; when on, a quiet tick made in the page (no file to fetch). Test: `switchFx.test.ts`.
- **R5** The tick stays silent while a meeting is recording or paused, or any microphone, camera or screen capture is open. Test: `switchFx.test.ts` (property).
- **R6** Settings → Appearance has "Ripple when switching tools" (on) and "Play a soft sound when switching tools" (off), remembered per browser. Test: `switchFx.test.ts`, `AppearanceSettings.test.tsx`.
