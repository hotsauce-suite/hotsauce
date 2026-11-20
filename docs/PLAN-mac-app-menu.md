# Plan: the Hotsauce and Help menus

Status (2026-11-20): built, in review. The owner pointed at Granola's app menu (About, Settings,
Check for Updates, Restart, Hide, Quit Completely, Quit) and accepted all five recommendations.

## Requirements

M1. The Hotsauce menu, in order: About Hotsauce, Check for Updates… / Settings… ⌘,, Switch
    Workspace…, Open at Login, Show in Menu Bar / Restart Hotsauce / Services / Hide Hotsauce ⌘H,
    Hide Others ⌥⌘H, Show All / Quit Completely ⌥⌘Q, Quit Hotsauce ⌘Q. [AppMenuLayoutTests]
M2. Quit Hotsauce (⌘Q) closes the windows and keeps the app running in the menu bar (dictation
    key, reminders, call detection). While something records it only hides the app. The first time,
    it says how to quit for real. Quit Completely, the Dock's Quit, logging out and restarting the
    Mac really quit. [AppMenuLayoutTests for the choice; checked on a Mac]
M3. Open at Login and Show in Menu Bar show a tick when on and flip on click, the same settings
    as Settings → This Mac. Restart Hotsauce reopens the app, never over a recording. Switch
    Workspace… opens the workspace step. [checked on a Mac]
M4. A Help menu: Hotsauce Help (hotsauce.work/help), Keyboard Shortcuts (the page's sheet, via the
    `hotsauce:show-shortcuts` event), Send Feedback… (/feedback), then Dictate…, Check
    Permissions…, Run Setup Again…, then Hotsauce on GitHub. [AppMenuLayoutTests,
    ShortcutsSheet.test]
M5. The menu bar icon's own Quit is now "Quit Completely" (it always quit for real).
