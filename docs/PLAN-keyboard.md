# Plan: keyboard shortcuts and the Command-K menu

## Status

Slice 1 shipped (#42, 0.8.1). Slices 2–4 merged (#47). Slices 5–7 in the next PR, then a release. Not built from the plan: `/` filtering inside Tasks (`/` opens Command-K everywhere instead), Tasks ⌘Z undo, and arrow keys in the Docs file tree. Plan accepted by the owner on 2026-11-13 (all recommendations). The readable plan is https://claude.ai/artifact/EAjxb3edzYx9NmvLs1ziHE.

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
- `keyboard/shortcuts.ts` owns one window `keydown` listener. Pages bind a handler to a catalog id with `useShortcut(id, run)`. The listener skips an event something else already handled (the editor's own ⌘K), skips plain keys while typing, while a dialog or menu is open, and Enter or Space on a control, and skips character keys when the member turned them off.
- Keys that CodeMirror or the Tables grid handle themselves are in the catalog as `handledBy: 'editor' | 'grid'`, so the sheet lists them; the listener never binds them.

- No two files may differ only in letter case (`keys.ts` and `Keys.tsx` collide on a Mac disk); `pnpm lint` runs `scripts/check-filename-case.mjs`. The keycaps component is `keyboard/KeyCaps.tsx`.

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

- C1: Command-K lists commands from a registry: Create (doc, meeting, task, note, voice note, clip, board, form, table, link), Go to (every app, Settings, agent brief, Connect Claude, Mac app, feedback), Preferences (theme, single-key switch, shortcuts sheet). Rows show their keys. With nothing typed it shows Recent, On this page and Create. [commandK.test, AppRail.test]
- C2: Typing filters commands: every typed word must start a word of the title, its synonyms or its group. Search results still lead when a title matches. [commandK.test, AppRail.test]
- C3: Pages and features register commands with `useCommands`; they show under "On this page" while mounted. A command with `confirm` asks before it runs. A command gets what was typed (for "Ask the assistant"). [commandK.test]

**Slice 4: on this page, for Docs, Meetings and Tasks**

- P1: On a doc or a meeting note, Command-K's On this page has: star or unstar, copy link, reading view or edit, version history, properties, save a version, attach a file (while editing), download as Markdown, and the page's own panels (a meeting's transcript and the like). [pageCommands.test]
- P2: In Tasks, On this page has Add a task, and for the selected task: complete or reopen, due today, due tomorrow, open, delete (which asks first, as the Delete key does). [pageCommands.test]

**Slice 5: the other apps, list keys and the editor**

- L1: `j` and `k` move the focus through the list in Meetings, Notes, Links, Files and People; Enter opens what has focus. [listKeys.test, NotesPage.test, PeoplePages.test, links.test]
- L2: Notes: `p` pins and `a` archives the note with focus; with none focused both do nothing. Links: `a` marks done, `o` opens the original page. Focus moves to the next row when one leaves the list. [NotesPage.test, links.test]
- L3: Files `u` opens the upload picker. Voice notes `r` starts a note, and stops and saves it while recording. ⌥⌘P pauses and resumes a recording. Clips `f` full screen, `m` mute. [listKeys.test, VoiceNotes.test]
- L4: Docs editor: ⌥⌘1–3 headings, ⌥⌘0 plain text, ⇧⌘7/8/9 numbered, bulleted and checklist (toggling off when already that kind), ⌘E inline code, ⇧⌘X strikethrough, ⌘Enter ticks a checklist item. [editor/commands.test]

**Slice 6: Command-K finds and does more**

- S1: Search results from every app say what they are (Doc, Meeting, Task, Note, File, Link, Person, …) and open in their own app. [commandK.test]
- S2: A pasted `http(s)` link offers Save link first; Enter opens Save link with it. "task …" or "todo …" offers Add task, which adds it through quick add without leaving the page. [commandK.test]
- S3: "Ask the assistant" is offered for anything typed, last, and hands the text over. [commandK.test]

**Slice 7: moving without a mouse, the Mac app, help**

- A1: The first Tab on any page reaches Skip to content, which focuses the page. Arrow keys, Home and End move along the rail. [a11y.test]
- A2: The Mac app's Go menu lists every rail app and Settings; ⌘1–⌘9 open the first nine. It mirrors `APPS`. [macRail.test]
- A3: The help page lists every key (site/public/help/shortcuts.html). [site/help.test]
