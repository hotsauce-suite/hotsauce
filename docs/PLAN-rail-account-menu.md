# Plan: a tidier rail and a fuller account menu

**Status:** built (Nov 19, 2026). Requirements 1 to 10, 12, 13 and 16 shipped in the first pull
request; 11, 14, 15 and 17 in the second. Morgan's answers (Nov 19): no Sign out in the menu;
Light, Dark and Auto; the rail remembers per device; the sign-in photo is the default; photos
show wherever a member is named; the delight is a pepper and a living logo. Still to do: new
screenshots and videos of the rail.

Morgan, Nov 19: clean up the left rail. The logo expands it so each icon sits beside its title,
every tool explains itself on hover, and Settings, music and feedback move into the account menu,
which also gains a light and dark switch, a profile photo, the versions and links to help.

Everything here is the web app, which the Mac app shows in its window, so the Mac app gets it with
the same release. The phone's tab bar does not change.

Shared files this touches: `apps/web/src/components/AppRail.tsx`, `AppShell.tsx`, `Menu.tsx`,
`apps/web/src/music/MusicButton.tsx`, `apps/web/src/api/types.ts` (the member's photo),
`apps/server/src/auth/principal.ts` and a new profile photo route, the shell's styles
(`--rail-width`), and the support materials (help pages, demo data, landing page, screenshots).

## Requirements (each maps to a test)

### The rail

1. Clicking the logo at the top of the rail widens it: each entry shows its icon with its full
   name beside it. Clicking again narrows it back to today's icons with small labels.
   *(AppRail.test: "R1, R2"; e2e app-rail: "the logo widens the rail")*
2. The rail remembers wide or narrow on this device, and opens that way next time. *(same tests)*
3. Hovering an entry (or focusing it with the keyboard) shows, after a short pause, a tip with one
   line saying what the tool is, and its shortcut. Escape or moving away hides it. A touch shows
   none. *(AppRail.test: "R3"; appShortcuts.test: "the rail (G3)")*
4. The rail no longer shows the Settings gear, the music note or Feedback. All apps (the grid) and
   the account button stay. *(AppRail.test: "shows the default pins"; e2e app-rail)*
5. `g` then `s` still opens Settings, and on Settings pages the account button is the one lit.
   *(appShortcuts.test G1; AppRail.test: "marks the account button")*

### The account menu

6. The menu opens from the account button and shows the member's face, name and email.
   *(AppRail.test: "R7"; e2e app-rail: "the account menu shows the email")*
7. A Light, Dark and Auto switch changes the theme at once; a theme made in Settings shows as its
   own choice, and "More themes" opens Settings, Appearance. *(AppRail.test: both "R7" tests)*
8. A Music row says what the music is doing and opens the controls under itself; the menu stays
   on screen as it grows. *(MusicMenu.test M2; e2e music M8)*
9. Settings, Keyboard shortcuts, Help and Send feedback (where feedback is on) are in the menu.
   *(AppRail.test: "R9"; e2e feedback, mcp, theme)*
10. The foot of the menu shows the Hotsauce version and, inside the Mac app, the Mac app's
    version; the version opens What's new. *(AppRail.test: both "R10" tests)*
11. The menu also has Edit pinned apps (the app grid opens ready to change the pins), What's new,
    and, on a Mac in a browser, Get the Mac app. No Sign out: it stays in Settings.
    *(AppRail.test: both "R11" tests; e2e app-rail: "the logo widens the rail")*

### Profile photo

12. A member picks a picture from the account menu (the face, or Add a photo) or from Settings,
    General. The browser crops its middle to a 256 px square before sending, the server keeps it
    in the account store (so backups hold it), and it shows on the account button and in the menu
    at once. *(profile/photo.test: three "R12" tests; server profile-photo.test: "R12"; e2e
    profile-photo)*
13. A member removes their photo and gets their initials back. *(profile/photo.test "R13";
    server profile-photo.test "R13"; e2e profile-photo)*
14. Until a member uploads one, the picture from their sign-in (their Google photo) is their
    photo: the server fetches a 256 px copy when it reads their account and keeps it like an
    upload. An upload is never replaced by it, and removing the upload brings it back; removing the
    sign-in picture itself leaves initials, and it stays away until the member uploads a photo.
    *(server account/signInPhotos.test: four "R14" tests; auth/clerk.test: "sign-in picture";
    server profile-photo.test "R14")*
15. Other members see the photo wherever a member is shown: People, comments, check-in answers and
    who is on a whiteboard. One list of who has a photo serves the whole app.
    *(server profile-photo.test "R15"; profile/photo.test: two "R15" tests)*
16. Only the member changes their own photo; an upload that isn't a JPEG, PNG or WebP by its bytes,
    or is over 500 KB, is refused with a plain message, and no photo is served without a session.
    *(server profile-photo.test: three "R16" tests; profile/photo.test: two "R16" tests)*

### Delight

17. A small pepper sits at the foot of the rail: it blinks, sleeps from ten at night to six,
    wears sunglasses in a dark theme, greets the member when the pointer rests on it and hops when
    a task is ticked off or a recording is saved. The logo wobbles under the pointer. Anything
    that moves stops under the system's reduce-motion setting, and Settings, Appearance turns the
    pepper and the wobble off (kept per browser). Short windows hide the pepper to keep room for
    apps. *(rail/Mascot.test: five "R17" tests; e2e app-rail)*

## Slices

1. Rail: widen from the logo, tips, the three buttons out (1 to 5).
2. Account menu: theme switch, music, links, versions (6 to 10).
3. Profile photo, server and web (12 to 16).
4. More menu rows, the sign-in photo, photos for everyone, delight (11, 14, 15, 17), then the support materials: help pages, demo data, landing page, screenshots.
