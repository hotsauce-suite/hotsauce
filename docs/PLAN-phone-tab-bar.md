# Plan: choose the apps on the phone's tab bar

**Status:** built Nov 17, 2026; every requirement below has a passing test.

The phone's bottom tab bar showed four fixed apps (Today, Docs, Tasks, Meetings) and an Apps tab.
Each member now picks which apps sit there and in what order, from the Apps sheet, the way the
desktop rail's pins work from the launcher (docs/PLAN-pinned-rail.md). This reverses that plan's
"the phone bar stays as it is" (Morgan, Nov 17: "Let users choose on mobile which apps to show up
in the bottom tab bar").

## Requirements (each maps to a test)

1. A new member's phone bar shows Today, Docs, Tasks and Meetings, then Apps, as before.
   *(AppRail.test: "is a tab bar of four apps and Apps on a phone")*
2. The phone bar shows the member's saved phone pins in their order, then Apps; ids this instance
   doesn't have are skipped, and an organization link (Chat) can be one of them.
   *(AppRail.test: "shows the member's chosen apps on the phone bar")*
3. The phone list is its own, separate from the desktop rail's pins: changing one leaves the other.
   *(pins.test: "keeps the phone list apart from the rail's")*
4. The Apps sheet has an "Edit tab bar" button. In edit mode it shows "On your tab bar" (the chosen
   apps, in order) above every app; tapping an app adds or removes it, chosen apps drag into a new
   order (Alt plus an arrow key moves the focused one), and Done leaves edit mode.
   *(AppsSheet.test; e2e mobile: "chooses the apps on the tab bar")*
5. The bar holds at most five apps (six tabs with Apps). With five chosen, the other apps can't be
   added and the sheet says to remove one first. None is allowed: the bar then shows only Apps.
   *(AppsSheet.test: cap; server api.test "phone pins")*
6. Phone pins are saved per member on the server (`GET/PUT /api/phone-pins`, in `account.sqlite`,
   max five, no repeats) and survive a reload and a new phone. The browser keeps a copy so the bar
   draws without waiting, and forgets it at sign-out. *(api.test "phone pins"; pins.test)*
7. The Apps tab is the current tab whenever the open page belongs to no app on the bar, and carries
   the recording dot whenever Meetings isn't on the bar. *(AppRail.test phone tests)*
8. For you's unread count shows on For you when it's on the bar, otherwise on Today, otherwise as
   a dot on Apps. *(AppRail.test: "puts the For you count where it can be seen")*

## Decisions taken (Morgan's answers, Nov 17)

- **Chosen in the Apps sheet,** not Settings: it's where you are when you want an app that isn't on
  the bar.
- **Its own list,** not the desktop pins: a rail fits many, a phone bar fits few.
- **Up to five apps** plus Apps. Labels still fit on a 320px-wide phone.
- **Organization links can go on the bar,** as on the rail; they open in a new tab.

## Shared files touched

`apps/web/src/components/AppRail.tsx`, `AppsSheet.tsx`, `Launcher.tsx` (drag logic moved to a shared
hook, no change in behavior), `apps/web/src/apps/pins.ts`, `apps/web/src/apps/registry.ts` and the
four manifests (`onPhoneBar` removed), `apps/server/src/account/store.ts` (one appended migration),
`apps/server/src/api/account.ts`, `apps/web/src/api/client.ts`, `apps/web/src/mocks/handlers.ts`.
