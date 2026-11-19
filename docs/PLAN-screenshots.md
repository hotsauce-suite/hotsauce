# Plan: screenshots in the Mac app

## Status

- 2026-11-19: decisions settled with the owner (below). Slice 1 (server and web) built: R1 to R3 in
  `apps/server/test/integration/files-expiry.test.ts`, R4 and R5 in `e2e/screenshots.spec.ts` and
  `apps/web/src/lib/macScreenshots.test.ts`, R6 already held (`outside-links.test.ts` R7).
- Slices 2 to 4 (the Mac app) not started.

## What it is

A screenshot tool built into the Hotsauce Mac app, in the spirit of Shottr and
[omasnap](https://github.com/omacom/omasnap) (MIT; it is a Wayland program, so its behaviour is
borrowed and the Mac code is written fresh in Swift). Press a shortcut, pick what to capture, and
the picture is on the clipboard at once. A small preview floats in the corner; the editor opens
only when asked. Nothing leaves the Mac until Share is pressed.

## Decisions (owner, 2026-11-19)

1. Lives in the Mac app (`apps/dictate-mac`), not a separate app and not a web page.
2. Shortcut ⌥⇧4 by default, changeable in Settings → This Mac.
3. One smart selection: drag for an area, click a window for that window, click the desktop for
   the whole screen. The size in pixels follows the pointer.
4. After a capture: copied to the clipboard, saved to the Mac's screenshots folder, and a preview
   floats in the corner for about 7 seconds with Edit, Copy, Share, Pin and drag-out.
5. Editor, first version: arrow, box, ellipse, text, highlighter, numbered steps, redact, crop,
   undo and redo, and "copy the text in this image". Later: scrolling capture, backdrops, pinned
   shots, ruler, colour picker.
6. Shots stay on the Mac. Share uploads one shot to Hotsauce and copies its link.
7. A shared shot lands in Files, in the member's personal space, folder `Screenshots`. No new app
   on the rail.
8. Share makes a link anyone on the web can open (when the organization allows public links;
   otherwise a link for signed-in members, and the app says so). A shared shot and its link are
   deleted 30 days after sharing unless the member presses Keep in Files.

## How the pieces fit

- **Capture** (Mac): `SCScreenshotManager` (macOS 14) grabs every display before the overlay
  shows, so the overlay is never in its own picture. Needs Screen Recording, asked for on the
  first capture and never during setup.
- **Shortcut** (Mac): the existing `HotkeyMonitor` event tap already sees every key; it gains a
  second, chorded shortcut (modifiers plus a key) that it swallows.
- **Editor** (Mac): annotations are vector layers over the untouched capture; the flattened PNG
  is made only on copy, save or share. The layer model, hit testing and undo history are pure
  code in `DictateCore` and tested there; drawing is AppKit.
- **Share** (Mac to web to server): the app has no server credentials of its own beyond
  Dictate's. The signed-in web app in the suite window does the upload: the app calls
  `window.hotsauceMac.shareScreenshot(name, pngBase64)` with `callAsyncJavaScript`, and the page
  uploads through the Files API, turns the link on and answers `{ ok, url, anyone, deleteAfter }`
  or `{ ok: false, error }`. With no page loaded or nobody signed in, Share says to open Hotsauce
  and sign in.
- **Auto-delete** (server): a Files pointer may carry `delete_after: <ISO time>`. A sweep removes
  files past it (pointer, bytes and link) with a commit by the server. Keep clears the field.

## Requirements (each has a test)

Server and web (slice 1):

- R1 An upload may ask for `deleteAfterDays` (1 to 365); the file's pointer then carries
  `delete_after`, and the file's view says when it goes.
- R2 The sweep removes a file past its `delete_after`: pointer, stored bytes and share link. A
  file without the field, or not yet due, is untouched.
- R3 Keep (`PATCH` the item with `keep: true`) clears `delete_after`; the sweep then leaves it.
- R4 Files shows "Deletes on <date>" with a Keep button on such a file.
- R5 `window.hotsauceMac.shareScreenshot` uploads a PNG to the personal space's `Screenshots`
  folder with 30 days to live, turns on a link (anyone when the organization allows it, else
  members) that ends when the file does, and answers with the absolute address.
- R6 A shared image link shows the picture to a signed-out visitor, with a download button.

Mac app:

- R7 (slice 2) The shortcut starts a capture; Esc cancels. A chord is parsed, shown and matched
  by tested pure code; it never fires Dictate.
- R8 (slice 2) Smart selection: the region math (drag rectangle, window under the pointer, whole
  display, native pixels on a scaled display) is pure and tested.
- R9 (slice 2) A capture is copied to the clipboard as PNG and saved to the screenshots folder
  with a timestamped name.
- R10 (slice 2) The preview shows for 7 seconds, pauses while hovered, and offers Edit, Copy,
  Share, Pin and drag-out.
- R11 (slice 3) Each tool adds a layer that can be selected, moved, resized, recoloured and
  deleted; undo and redo walk the history (tested on the model).
- R12 (slice 3) Redact covers pixels in the flattened picture for good: the exported PNG holds
  no original pixels under it (tested on rendered output).
- R13 (slice 3) Copy text reads the picture with Vision and copies what it found.
- R14 (slice 4) Share uploads through the page and copies the link; failures say what to do.
- R15 (slice 4) Settings → This Mac has the shortcut, the folder, and "after a capture" choices.

## Slices

1. Server and web: R1 to R6. Shared files: `packages/format/src/files.ts`,
   `apps/server/src/files/service.ts`, `apps/server/src/api/drive.ts`, Files page.
2. Mac: shortcut, capture, clipboard, save, preview. Shared files: `HotkeyMonitor.swift`,
   `AppDelegate.swift`, `Permissions.swift`, `MainMenu.swift`.
3. Mac: editor.
4. Mac: Share, Settings → This Mac (`MacSettingsBridge.swift`, `ThisMacPage.tsx`), help docs,
   landing page, STATUS.
