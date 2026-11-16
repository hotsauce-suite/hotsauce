# Plan: the apps look and act the same

**Status:** (Nov 16, 2026) Round 1 is shipped in full: requirements 1 to 5 (0.18.0, PR #117),
Links and the words (PR #128), plain titles with "Boards" (PR #130), the re-recorded app videos
(PR #133), and now "Saved" for "Committed" on a doc's save chip. Round 2 (the top bar) is being
built in steps: the red main button (PR #145) and "‹ App name" with × on pop-ups (PR #148) are
merged, as is one "Share" button (PR #150), and the phone top bar is in its PR. The videos and screenshots
are re-recorded once, after the last step. Round 3 not started.
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
    the page's words do. Exception: Notes keeps its search field in the bar until round 3.
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

## Round 3

12. One row above every list: Personal / Team on the left, search on the right.
13. Two page widths (reading, gallery), one heading size, one button height.

## Shared files this touches

Round 1: new `apps/web/src/components/LoadError.tsx` and `EmptyState.tsx`; a few lines in each
app's list page; `components/FileTree.tsx`, `state/treeStore.ts`. `SaveState.tsx` waits for requirement 6 (after
offline step A).
Round 2: `components/AppShell.tsx`, `TopBar.tsx`, `Sidebar.tsx`, every app's page header.
