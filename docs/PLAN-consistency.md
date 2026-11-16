# Plan: the apps look and act the same

**Status:** (Nov 16, 2026) Round 1 is shipped in full: requirements 1 to 5 (0.18.0, PR #117),
Links and the words (PR #128), plain titles with "Boards" (PR #130), the re-recorded app videos
(PR #133), and now "Saved" for "Committed" on a doc's save chip. Round 2 (the top bar) is shipped:
the red main button (PR #145), "‹ App name" with × on pop-ups (PR #148), one "Share" button
(PR #150) and the phone top bar (PR #152), with the app videos and README screenshots re-recorded
after the last step. Round 3 (one row above every list) is shipped: ten apps on the shared row (PR #154), Tasks and
Meetings (PR #155), and the app videos, README screenshots and help pages re-done after it.
The narrated tour video and the Clips player video are re-cut from the new screens and on the
site; the copy on YouTube is the old cut until Morgan uploads the new file (his to-do list).
The three leftovers from the round 3 review are done: the list is a tab panel named by its tab
(`ListPanel`), and tests cover dragging being off while Tasks is searched and Meetings filters
with a search. Round 4 (the pages inside things) starts in its own thread.
Morgan accepted all seven patterns on Nov 15 ("yes" to Q1 to Q7).

Every app built its own top bar, empty screen and error message, so the same moment looks and
reads differently from app to app. This plan gives them shared pieces and one set of words.
It ships in rounds; round 1 moves no control.

## Round 1: nothing moves

### Requirements (each maps to a test)

1. **One "couldn't load" block.** When an app's list fails to load, the list area shows
   "Couldn’t load your <things>." with "Check your connection and try again." and a **Try again**
   button, as an alert. The server's own sentence is never shown.
   *(LoadError.test; e2e consistency: "a list that fails to load")*
2. It is used by every list: Today, Docs (the file tree), Meetings, Voice notes, Clips, Tasks,
   Notes, Boards, People, Files, Links, Forms, Check-ins, Tables, Pages and Briefcast. *(e2e consistency, one case per app)*
3. Try again loads the list without reloading the page. *(e2e consistency)*
4. While a list has failed, its empty message is not shown, and the page's own buttons stay
   where they were. (Check-ins is the exception: who may make a check-in comes with the list,
   so its buttons return with it.) *(e2e consistency: every failed-list case checks that no
   empty screen shows)*
5. **One empty screen.** A list with nothing in it shows, centred in the list area, the app's
   icon, a headline ("No forms yet"), one sentence, and where the app has one, its main button.
   Lists that are meant to reach empty keep their own headline ("Your inbox is clear").
   *(EmptyState.test; e2e consistency: "an empty list", one case per app)*
6. **One set of words.** "New …" makes anything ("New task", "New doc", "New meeting"), with the
   full words on a phone. "Record a clip", "Upload" and "Save" (a link) keep their verbs.
   "Personal" and "Team" name whose it is. A doc's saved status reads "Saved", never "Committed".
   *(web unit tests per app; e2e specs that click these buttons)*
7. **Plain titles.** An app's title is its plain name, shown once: the sidebar says "Tasks", and
   the page's top bar says where you are in the app. Boards is "Boards" everywhere.
   *(e2e consistency: "titles")*

### Decisions taken

- "Share" as the one sharing button (Q3) moves "Copy link" and "Get share link" inside a menu,
  so it ships with round 2's top bar, not here.
- The error block names the app's own noun, never the server's message, because the message
  for a failed request is the same for every cause a teammate can act on: try again.
- Quick-add rows (Tasks, Notes, Links) keep their own placeholder text.

## Round 2: the top bar (after offline step A and Links reading position merge)

8. **The one red button** is the last control at the top right of every app's page, on computer
   and phone, and always shows its words: New doc, New meeting, Record a voice note, Record a
   clip, New task, New note, New board, Upload, Save a link, New form, New check-in (admins),
   New table, Make today's briefing. Today, People, Pages and Dictate make nothing, so they have
   none. Forms and Tables make an untitled item with the cursor in its name.
   *(e2e consistency: "the main button", one case per app at both widths; PageHeader.test;
   e2e forms and tables)*
9. **Back and close.** The page of one thing (a board, a clip, a form, a table, a saved link,
   a check-in, a person, a shared page, Record a clip, New meeting, an import) shows "‹ App
   name" at the left of the top bar, in the menu's place on a phone, and it leads to the list.
   Every pop-up has an × at its top right, as side panels do. Docs and meeting notes keep their
   breadcrumb beside the sidebar.
   *(PageHeader.test; Dialog.test; e2e boards, clips, forms, tables, links, check-ins, people)*
10. **One "Share" button.** Wherever a thing can be sent to someone, the button says **Share**
    and opens a menu; **Copy link** is the first item, and the app's other ways of sharing (read-only
    link, Share with team, Make private, Move to Team, the copy to paste into a doc) are inside
    it. Docs, Meetings, Clips, Forms, Files, Links, Boards and Pages. Escape closes the menu only,
    not the pop-up it sits in, and the keyboard goes back to the button.
    Exceptions: a note has no address of its own (it opens over the board), so its share icon,
    named Share, holds the read-only link and Move to Team without Copy link; a booking link's
    row keeps its own "Copy link" button, because copying is all that row is for.
    *(ShareButton.test; e2e `expectShareWithCopyLink` in drive, links, boards, clips, forms;
    notes.spec)*
11. **A phone's top bar.** The menu (or "‹ App name" on the page of one thing), the title, the
    one main button with its words at the far right, and **More** (⋯, just before it) for
    everything else: Share's items, Open, Trim, Download, Delete, New folder, Import. A doc shows
    its name (its heading) instead of its file name, with Share and More. The Ask button covers
    no control, and sits above a board's own tools. A title with nothing before it starts where
    the page's words do. Exceptions: Notes keeps its search field in the bar until round 3, Ask about meetings keeps its
    picker, and a meeting being recorded keeps Pause, Keep audio and Stop in reach.
    *(e2e consistency: "a phone’s top bar")*

### Decisions taken in round 2

- Share is `components/ShareButton.tsx`; a copied link is confirmed by the toast at the bottom
  (`notify`), not by the button changing its word. In Links, "Copy link" copies the address of
  the saved copy here (like everywhere else) and "Copy the page’s web address" copies the original.
- In Files, "Copy link" turns the file's link on if it was off, as "Copy share link" in the row's
  menu always did; the toast and the line under the button say who can open it, and "Turn off
  link" sits next to it in Share.
- Pages: "Delete page" left the Share menu and is its own button.
- The top bar is `components/PageHeader.tsx` (`PageHeader`, `MainButton`); the old name
  `MeetingsPageHeader` still points at it so pages move over one at a time.
- With more than one space, "New form", "New table" and "Import" first ask whose it is
  (Personal or Team) in a small menu; with one space a press makes it. Until the member's spaces
  have loaded the button waits, so it can't make a team item by mistake.
- Where a page keeps a quick-add row (Tasks, Notes, Links), the top-right button opens or
  focuses that row. Links' own "Save" beside the paste field is no longer red: one red button.
- Docs' start page has the top bar on a computer too, and the sidebar's "New doc" is the same
  red button as in the other sidebars.
- The app videos and screenshots are re-recorded once, at the end of round 2, because each step
  of the round changes the same top bars.

## Round 3: one row above every list

Morgan accepted all seven round 3 answers on Nov 16 ("yes" to Q1 to Q7). The before page:
https://claude.ai/artifact/RwNw6CiwRzJgynzKJHYSeq

### Requirements (each maps to a test in `e2e/consistency.spec.ts` unless it names another)

12. Every list has one row right under the top bar (`components/ListBar.tsx`): its tabs at the
    left edge, its search at the right edge. No search field sits in the top bar. The lists:
    Tasks, Meetings, Clips, Notes, Boards, Files, Links, Forms, Tables, Pages, Check-ins, People.
13. Every list has a search. Where there was none (Tasks, Forms, Tables, Pages, Check-ins) it
    filters the list by name as you type: every word typed is somewhere in the name. When nothing
    matches, the list says "No … match that".
14. The tabs. Clips and Boards: Personal, Team. Notes, Forms, Tables and Pages: All, Personal,
    Team, with All first so nothing is hidden on arrival. Links: Unread, Archive, Highlights.
    Tasks: Inbox, Today, Upcoming, All, Done (each its own address). Files (folders in its side
    list), Check-ins and People (one team list each) and Meetings (one page of sections) have no tabs; Files shows the folder
    path where the tabs would be. A Personal / Team tab is kept in the address (`?scope=team`).
15. No title twice. The top bar names the app; the list does not repeat it, and a view's name is
    its selected tab, not a second big title. A view that is not a tab (a Notes label, Archive or
    Trash; a Tasks project) is named in the one list heading size (`listHeading`).
16. An app's intro paragraph shows only on its empty screen. With items, the list starts right
    under the row.
17. Two widths (`ListColumn`): rows of text (Tasks, Meetings, Links, Forms, Tables, Pages,
    Check-ins, People) sit in one centered column; grids of cards (Clips, Boards, Notes, Files)
    run wide. Every list of one kind measures the same.
18. On a phone the row stacks: tabs, then the search under them at full width. Files has its
    search on a phone, and Notes' search is out of the top bar. Nothing scrolls sideways.
19. The app videos, README screenshots, help pages and the tour video show the row.

Voice notes and Briefcast keep their own layouts (Morgan, Q7 note).

### Slices

1. The shared row, and Clips, Boards, Notes, Files, Links, Forms, Tables, Pages, Check-ins,
   People on it (requirements 12 to 18 for those ten).
2. Tasks and Meetings: tabs, search, no second title, one heading size.
3. Requirement 19: videos, screenshots, help pages; then the tour video and the Clips player video.

### Decisions taken in round 3

- Personal / Team is sorted in the browser from the list already loaded; no server change.
- A person's or company's own page keeps its wider column; only the People list is a list.
- Links keeps its "Paste a link to save" row, now under the row of tabs and search.
- Meetings has no tabs. This changes the answer Morgan accepted in Q3 ("Tasks, Meetings and Saved
  links keep their own views as the tabs"); he is told in the thread. Its page is sections (Coming
  up, Recent meetings, Action items, All meetings), not views, and putting the list of past meetings behind a tab would hide it on arrival. The
  sections keep their names in the one list heading size. The row's search looks through
  meetings by name and by who was there; while it has words in it the matches are all the page
  shows, the filters don't apply, and a button under them opens the search of what was said. The "Search meetings and docs" button left Meetings' side list (Ctrl/Cmd K still opens it).
- Tasks' search filters the list on screen by name; dragging to reorder is off while it has words.
  It empties when you change list or add a task, so nothing new is hidden.
  The "3 open" count and today's date sit under the row in small type.

## Shared files this touches

Round 1: new `apps/web/src/components/LoadError.tsx` and `EmptyState.tsx`; a few lines in each
app's list page; `components/FileTree.tsx`, `state/treeStore.ts`. `SaveState.tsx` waits for requirement 6 (after
offline step A).
Round 2: `components/AppShell.tsx`, `TopBar.tsx`, `Sidebar.tsx`, every app's page header.
Round 3: new `components/ListBar.tsx`; the top of every app's list page; `styles/clips.css` (the tabs).
