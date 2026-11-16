# Plan: the apps look and act the same

**Status:** (Nov 16, 2026) Round 1 is shipped: requirements 1 to 5 (0.18.0, PR #117), Links
and the words of requirement 6 (PR #128), and plain titles with "Boards" (requirement 7, this
PR). Two pieces of round 1 are left for later rounds: "Saved" for "Committed" waits for the
offline work to merge (it rewrites `SaveState.tsx`), and "shown once" (the page's top bar naming
where you are instead of repeating the app's name) comes with round 2's shared top bar. Rounds 2
and 3 not started. Morgan accepted all seven patterns on Nov 15 ("yes" to Q1 to Q7).

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

8. The one red button is at the top right of every app, on computer and phone. Forms and Tables
   make an untitled item named on the next screen.
9. A full-page item shows "‹ App name" at the left of the top bar; every pop-up and side panel
   has an × at its top right (Tables, Clips and the Files preview have neither today).
10. One "Share" button with "Copy link" inside it.
11. Phone top bar: menu, title, the one main button with its words; the rest behind "More". The
    assistant button never covers a control. A doc's title is its name, not its file name.

## Round 3

12. One row above every list: Personal / Team on the left, search on the right.
13. Two page widths (reading, gallery), one heading size, one button height.

## Shared files this touches

Round 1: new `apps/web/src/components/LoadError.tsx` and `EmptyState.tsx`; a few lines in each
app's list page; `components/FileTree.tsx`, `state/treeStore.ts`. `SaveState.tsx` waits for requirement 6 (after
offline step A).
Round 2: `components/AppShell.tsx`, `TopBar.tsx`, `Sidebar.tsx`, every app's page header.
