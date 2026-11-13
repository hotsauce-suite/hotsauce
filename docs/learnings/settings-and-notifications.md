# Learnings: installing the app, Settings and notifications

- **One push subscription feeds four things.** Meeting reminders, task reminders, check-in questions and the daily briefing all send through `meetings.reminderStore`. Any switch or copy about "notifications" covers all of them; naming only reminders misleads people who turn it off.
- **`beforeinstallprompt` fires once, early.** It can come before any React component mounts, so `lib/install.ts` listens when the module loads and keeps the event. A prompt can only be shown once; drop it after `prompt()`.
- **iPadOS says it's a Mac.** Detect iPad as `Macintosh` plus `navigator.maxTouchPoints > 1`. jsdom has no `maxTouchPoints`; tests set it with `Object.defineProperty` (`src/test/devices.ts`).
- **Spying on `matchMedia` twice in one test recurses** if the second spy wraps the first. Keep a bound copy of the real one at module load.
- **The service worker registers after load.** A first visit straight to `/settings` can ask for the registration before it exists and wrongly call the browser unsupported; `reminderState()` waits up to 3 s for `serviceWorker.ready`.
- **A send that throws isn't "no device".** The test-notification route counts failures separately so the page can say "couldn't reach" instead of "not set up".
- **Live regions must exist before their text changes.** A `role="status"` element inserted already filled is often not announced; render it empty and change its text.
- **The demo has no service worker**, so install prompts and the Settings install card are hidden when `import.meta.env.MODE === 'demo'`.
- **Several threads share `/Users/morgz/code/hotsauce`.** Work in your own `git worktree` from the start; otherwise another thread can switch the branch under you.
