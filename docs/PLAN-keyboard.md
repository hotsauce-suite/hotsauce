# Plan: keyboard shortcuts and the Command-K menu

## Status

Slice 1 in progress on branch `claude/project-thread-0ulpa9`. Plan accepted by the owner on 2026-11-13 (all recommendations). The readable plan is https://claude.ai/artifact/EAjxb3edzYx9NmvLs1ziHE.

## Decisions

Settled with the owner on 2026-11-13. He accepted every recommendation.

- Apps are reached with `g` then a letter, everywhere. The Mac app also puts every rail app on ⌘1–⌘9.
- Shortcuts are a fixed set: no rebinding. Settings has a switch to turn single-key shortcuts off (WCAG 2.1.4).
- Command-K may delete the open doc or task, behind a confirm step.
- Sign out is not in Command-K; it stays in Settings.
- ⌘J is reserved for the AI assistant panel (built in its own thread), which adds an "Ask the assistant" Command-K command.
- Build in slices, each merged and shipped on its own.

## Design

- `apps/web/src/keyboard/catalog.ts` is the one list of shortcuts: id, keys, label and section. The key listener, the `?` sheet, Command-K's key hints and tooltips all read it. A test fails when two shortcuts in one scope share keys, or one uses a key the browser or the Mac owns.
- `keyboard/keys.ts` is pure: parse a key spec (`mod+k`, `g d`, `?`, `shift+mod+8`), match a `KeyboardEvent`, and format keycaps for Mac (⌘ ⌥ ⇧) and others (Ctrl Alt Shift).
- `keyboard/KeyboardProvider.tsx` owns one window `keydown` listener. Pages bind a handler to a catalog id with `useShortcut(id, run)`. The listener skips an event something else already handled (the editor's own ⌘K), skips plain keys while typing, while a dialog or menu is open, and Enter or Space on a control, and skips character keys when the member turned them off.
- Keys that CodeMirror or the Tables grid handle themselves are in the catalog as `handledBy: 'editor' | 'grid'`, so the sheet lists them; the listener never binds them.

## Requirements

Each requirement maps to a test, named in brackets.

**Slice 1: one shortcut list, the `?` sheet, the Settings switch**

- K1: A key spec parses into strokes; `mod` matches ⌘ or Ctrl; a symbol key like `?` matches whatever Shift it took; with Alt held, letters and digits match by physical key. [keys.test]
- K2: Keycaps format as ⌘K / ⌥⌘1 / ⇧⌘8 on a Mac and Ctrl+K / Ctrl+Alt+1 elsewhere; a sequence shows each stroke. [keys.test]
- K3: The catalog has no two shortcuts with the same keys in one scope (global collides with every section), and none uses a browser- or Mac-owned key (⌘T ⌘W ⌘N ⌘L ⌘R ⌘Q ⌘H ⌘M ⌘1–9, ⇧⌘T, ⇧⌘N, devtools keys). [catalog.test]
- K4: The listener runs the bound handler and prevents the default; it ignores plain keys while typing in a field, while a dialog or menu is open, and Enter or Space on a button, link or checkbox (except play and pause, which only leaves Space to the video); ⌘ keys still work while typing, also by physical key on a non-Latin layout; an event already handled, or an IME commit, is left alone. [shortcuts.test]
- K5: A handler that returns false lets the key through (not prevented). The most recently mounted handler for an id wins, and unmounting restores the previous one. [shortcuts.test]
- K6: With single-key shortcuts off (Settings), character keys do nothing; ⌘ keys, arrows and Enter still work. The choice is kept on this device. [shortcuts.test, ShortcutsSheet.test]
- K7: `?` opens the keyboard shortcuts sheet, listing Everywhere first, then the sections active on this page, then the rest. The sheet takes focus; Esc closes it and focus returns. [ShortcutsSheet.test]
- K8: ⌘K, the Tasks keys and the Clips keys run through the shortcut list with no change in behavior. [ShortcutsSheet.test (⌘K), TasksPage.test (keyboard), shortcuts.test (Clips' Space rule); the Clips page has no web test harness yet, so its keys were checked in a real browser]

**Slice 2: go anywhere, create from the keyboard**

- G1: `g` then a letter opens that app (h Today, d Docs, m Meetings, t Tasks, n Notes, v Dictate, c Clips, i Check-ins, b Boards, p People, f Files, o Forms, e Tables, l Links, r Briefcast, s Settings). A pause over 1.2 s cancels the `g`; typing in a field never triggers it. [appShortcuts.test]
- G2: `c` creates the app's main thing where it has one (Docs: new doc, Tasks: quick add, Notes: new note, Meetings: start, Clips: record, Dictate: voice note, Boards: new board, Forms and Tables: the new-title box); `/` opens Command-K; ⌘\ hides and shows the sidebar (the drawer on a phone). A page's own binding wins over the app-wide default. [appShortcuts.test, shortcuts.test]
- G3: The rail's tooltips show each app's `g` keys. [appShortcuts.test]

**Slice 3: Command-K actions**

- C1: Command-K lists commands from a registry: Create, Go to (apps, Settings sections, Starred, Recent), Preferences (theme, single-key switch, shortcuts sheet). Each row shows its keys. [CommandK.test]
- C2: Typing filters commands by words and synonyms; search results still lead when a title matches. [CommandK.test]
- C3: Pages and features register commands with `useCommands`; they show under "On this page" while mounted. [CommandK.test]

Slices 4 to 7 (page actions for Docs, Meetings and Tasks; the other apps and list keys; search every kind; accessibility, the Mac app and support materials) get their requirements here when they start.
