# Plan: the Mac app checks its permissions at every start

Status (2026-11-14): building, release 0.12.4. Asked for by the owner: "On startup, the desktop app
needs to check whether it has all its necessary permissions. If not, it should automatically pop up
the permissions window every single time on startup."

## Requirements

P1. At every launch (login-item launches too), the app reads Microphone, Accessibility, Location
    (the app's access and Location Services for the Mac) and Notifications. Notifications count only
    while meeting reminders, or call-notes offers on macOS 14.2+, are on in Settings, since nothing
    else shows one.
    [DictateCoreTests/PermissionCheckTests]
P2. If any of those is missing, granted-but-refused included, the setup window opens and comes to
    the front; it does so at every launch until all are granted. The first launch always shows it.
    [PermissionCheckTests, manual check on the Mac]
P3. Once everything is granted (and the Mac was set up before), a launch opens no setup window.
    [PermissionCheckTests, manual check on the Mac]
P4. The setup window lists Location and Notifications with live checks next to Microphone,
    Accessibility and Connect. Location's Allow shows macOS's prompt the first time and opens
    Location Services in System Settings after a refusal; Notifications' Allow shows macOS's prompt
    the first time and opens the app's Notifications settings after a refusal. Only the row whose button
    sent the member to System Settings brings the window back when it turns green. [manual check on the Mac]
P5. The window opens any time from the menu bar icon (Check permissions…) and from the app menu
    (Hotsauce → Check Permissions…), so a hidden menu bar icon doesn't hide it. [manual check]
P6. What was missing at the last launch is kept for diagnosis:
    `defaults read dev.hotsauce.dictate status.missingAtLaunch`. [manual check]

## Not checked at launch

Camera, screen recording and system audio recording are asked for when a clip or a call recording
first needs them. macOS has no public way to read the system-audio permission, and asking for screen
recording at every start would nag people who never record their screen.
