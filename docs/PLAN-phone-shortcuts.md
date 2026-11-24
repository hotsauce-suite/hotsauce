# Plan: phone shortcuts on Android and iPhone, and the Mac app's Dock menu

**Status:** built Nov 24, 2026. Every requirement below has a passing test (the Swift tests run in the Mac app CI job). Still to check on real
devices: holding the icon on an Android phone, and an iPhone shortcut, a Home Screen icon and the
Action Button.

Morgan uses an Android phone and Rajiv an iPhone. Both wanted to get from the Home Screen straight
to an action. An installed web app can do this cheaply on both phones. Live widgets would need a
native app, and that decision is separate.

- **Android** shows the web app manifest's `shortcuts` when the installed app's icon is held.
- **iPhone** ignores them. Apple's Shortcuts app gives the same result instead: an **Open URLs**
  shortcut, put on the Home Screen, in the Shortcuts widget or on the Action Button. It opens
  Safari, not the Home Screen app, so the member signs in once in Safari.
- **Mac app**: right-click the Dock icon, or use the menu bar menu (Morgan's desktop-too rule).

One list, `apps/web/src/lib/phoneShortcuts.ts`, feeds the manifest (`vite.config.ts`) and the
Settings card. The Mac app's copy in `apps/dictate-mac/Sources/DictateCore/QuickActions.swift` is
kept equal by a test.

## Decisions (Morgan, Nov 24: "yes" to all five)

1. The actions, in this order: New voice note, New task, Save link, Ask, Ramble. Some launchers
   show only four, so Ramble comes last.
2. Save link reads the clipboard only after a tap (**Paste and save**). Saving without a tap
   would let any page that opens the address save whatever is copied. There is a box to paste
   into when the browser won't share the clipboard.
3. The iPhone gets a "Save to Hotsauce" share-sheet shortcut too: URL Encode, Text, Open URLs.
4. A **Phone shortcuts** card in Settings → Apps, and the help page
   hotsauce.work/help/phone-shortcuts.
5. The Mac app gets New Task, Save Link, Ask and Ramble Tasks in the Dock menu and the menu bar
   menu. The voice note stays out, because Dictate and Meetings do that job on a Mac. Save Link
   reads the Mac's clipboard itself, and the page still asks before saving.

## Requirements (each maps to a test)

1. The list holds the five actions in order, with their addresses, and the manifest's `shortcuts`
   come from it. *(lib/phoneShortcuts.test.ts R1; e2e dictate-voice-mobile: the served manifest)*
2. `/tasks?new=1` opens quick add and removes the parameter from the address.
   *(TasksPage.test R2)*
3. `/tasks?ramble=1` opens quick add straight into Ramble, which starts listening.
   *(TasksPage.test R3)*
4. `/links/save?paste=1` offers Paste and save. A copied link is saved with source `shortcut`.
   Text that isn't a link says so, and the box saves a pasted address.
   *(links.test R4, two cases)*
5. Settings → Apps → Phone shortcuts shows Android the steps for holding the icon. For iPhone it
   lists each action's full address with a Copy button, the share-sheet steps, and a note that
   shortcuts open Safari. *(PhoneShortcuts.test R5)*
6. Any page with `?ask=1` opens the assistant and removes the parameter.
   *(PhoneShortcuts.test R6)*
7. The Mac app's quick actions use the same addresses as the web list, without the voice note.
   Save Link uses the copied link when there is one. *(phoneShortcuts.test R7;
   QuickActionsTests.swift)*

## Not done here

- Native live widgets on Android and iPhone. That decision stays in the widgets brainstorm.
- iCloud links to ready-made shortcuts. They need an Apple device to make them, and each link
  would name one server's address.
